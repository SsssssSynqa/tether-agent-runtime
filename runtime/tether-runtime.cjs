// SPDX-License-Identifier: Apache-2.0
'use strict';

const { CausalJournal, CausalStateError } = require('./causal-journal.cjs');

class TetherRuntime {
  constructor({
    session,
    memory,
    provider,
    causalJournal = null,
    personaPrompt = '',
    rawTailMessages = 40,
    summaryLimit = 20,
    cardLimit = 20,
    log = console.log,
  } = {}) {
    if (!session || !memory || typeof provider?.respond !== 'function') {
      throw new Error('TetherRuntime requires session, memory, and a provider adapter');
    }
    this.session = session;
    this.memory = memory;
    this.provider = provider;
    this.causal = causalJournal || new CausalJournal({ directory: memory.directory });
    this.personaPrompt = String(personaPrompt || '');
    this.rawTailMessages = rawTailMessages;
    this.summaryLimit = summaryLimit;
    this.cardLimit = cardLimit;
    this.log = log;
    this.channels = new Map();
    this.queue = Promise.resolve();
  }

  attach(channel) {
    if (!channel?.id || typeof channel.onMessage !== 'function' || typeof channel.send !== 'function') {
      throw new Error('A channel requires id, onMessage, and send');
    }
    if (this.channels.has(String(channel.id))) throw new Error(`Channel ${channel.id} is already attached`);
    this.channels.set(String(channel.id), channel);
    channel.onMessage((message) => this.enqueue(channel, message));
    return this;
  }

  enqueue(channel, message) {
    const task = this.queue.then(() => this.handle(channel, message));
    this.queue = task.catch((error) => this.log(`[tether] turn failed: ${error.message}`));
    return task;
  }

  _assistantRecord(sessionId, channelId, causalRecord) {
    const output = causalRecord.output;
    return this.memory.appendMessage({
      messageId: output.outputId,
      sessionId,
      channelId,
      role: 'assistant',
      text: output.text,
      metadata: {
        causalId: causalRecord.causalId,
        providerId: output.providerId,
      },
    }).record;
  }

  _checkpoint(sessionId) {
    if (typeof this.session.checkpoint !== 'function') return;
    const result = this.memory.sessionProof(sessionId);
    if (!result.passed) throw new Error(`Memory checkpoint failed: ${result.errors.join(', ')}`);
    this.session.checkpoint(result.proof);
  }

  async _deliver(channel, sourceMessage, causalRecord, { replayed }) {
    const started = this.causal.markDeliveryStarted(causalRecord.causalId);
    try {
      await channel.send({
        text: started.output.text,
        replyToMessageId: sourceMessage.messageId,
        sourceMessage: structuredClone(sourceMessage),
        outputId: started.output.outputId,
      });
    } catch (error) {
      this.causal.markDeliveryFailed(causalRecord.causalId, error);
      throw error;
    }
    const delivered = this.causal.markDelivered(causalRecord.causalId);
    return { delivered, replayed };
  }

  async handle(channel, message) {
    if (!message?.messageId) throw new Error('Channel message requires a stable messageId');
    const state = await this.session.open({ allowCreate: Boolean(message.allowCreateSession) });
    const prepared = this.causal.prepareInput({
      sessionId: state.sessionId,
      channelId: channel.id,
      messageId: message.messageId,
      role: 'user',
      text: message.text,
      metadata: message.metadata || {},
    });
    let causalRecord = prepared.record;

    if (causalRecord.state === 'inference-started') {
      throw new CausalStateError(
        'Inference started without a durable output; refusing ambiguous reinference',
        'TETHER_INFERENCE_AMBIGUOUS',
        { causalId: causalRecord.causalId },
      );
    }
    if (causalRecord.state === 'delivery-started') {
      throw new CausalStateError(
        'Delivery started without a durable acknowledgement; refusing ambiguous resend',
        'TETHER_DELIVERY_AMBIGUOUS',
        { causalId: causalRecord.causalId },
      );
    }
    if (causalRecord.state === 'delivered') {
      const assistant = this._assistantRecord(state.sessionId, channel.id, causalRecord);
      this._checkpoint(state.sessionId);
      return {
        sessionId: state.sessionId,
        causalId: causalRecord.causalId,
        assistant,
        outputId: causalRecord.output.outputId,
        replayed: true,
        alreadyDelivered: true,
      };
    }
    if (['committed', 'delivery-failed'].includes(causalRecord.state)) {
      const assistant = this._assistantRecord(state.sessionId, channel.id, causalRecord);
      this._checkpoint(state.sessionId);
      await this._deliver(channel, message, causalRecord, { replayed: true });
      return {
        sessionId: state.sessionId,
        causalId: causalRecord.causalId,
        assistant,
        outputId: causalRecord.output.outputId,
        replayed: true,
        alreadyDelivered: false,
      };
    }
    if (causalRecord.state !== 'received') {
      throw new CausalStateError(
        `Unsupported causal state ${causalRecord.state}`,
        'TETHER_CAUSAL_STATE_UNKNOWN',
        { causalId: causalRecord.causalId },
      );
    }

    const user = this.memory.appendMessage({
      messageId: message.messageId,
      sessionId: state.sessionId,
      channelId: channel.id,
      role: 'user',
      text: message.text,
      metadata: message.metadata || {},
    }).record;
    this._checkpoint(state.sessionId);
    causalRecord = this.causal.markInferenceStarted(causalRecord.causalId);
    const compiled = this.memory.compileContext({
      rawTailMessages: this.rawTailMessages,
      summaryLimit: this.summaryLimit,
      cardLimit: this.cardLimit,
    });
    const messages = [
      ...(this.personaPrompt ? [{ role: 'system', content: this.personaPrompt }] : []),
      ...compiled.summaries.map((entry) => ({ role: 'system', content: entry.text })),
      ...compiled.cards.map((entry) => ({
        role: 'system',
        content: `[Tether memory card: ${entry.cardType}:${entry.period.key}]\n${entry.content}`,
      })),
      ...compiled.rawTail.map((entry) => ({ role: entry.role, content: entry.text })),
    ];
    const result = await this.provider.respond({
      sessionId: state.sessionId,
      channelId: channel.id,
      messages,
      sourceMessage: user,
    });
    causalRecord = this.causal.commitOutput(causalRecord.causalId, {
      text: result.text,
      providerId: result.providerId || null,
    });
    const assistant = this._assistantRecord(state.sessionId, channel.id, causalRecord);
    this._checkpoint(state.sessionId);
    await this._deliver(channel, message, causalRecord, { replayed: false });
    return {
      sessionId: state.sessionId,
      causalId: causalRecord.causalId,
      user,
      assistant,
      outputId: causalRecord.output.outputId,
      provider: result,
      replayed: false,
      alreadyDelivered: false,
    };
  }
}

module.exports = { TetherRuntime };
