// SPDX-License-Identifier: Apache-2.0
'use strict';

const { CausalJournal, CausalStateError } = require('./causal-journal.cjs');

class TetherRuntime {
  constructor({
    session,
    memory,
    provider,
    maintenanceSupervisor = null,
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
    this.maintenanceSupervisor = maintenanceSupervisor;
    this.causal = causalJournal || new CausalJournal({ directory: memory.directory });
    this.personaPrompt = String(personaPrompt || '');
    this.rawTailMessages = rawTailMessages;
    this.summaryLimit = summaryLimit;
    this.cardLimit = cardLimit;
    this.log = log;
    this.layeredMemory = typeof memory.ensureTurn === 'function'
      && typeof memory.buildMessages === 'function';
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

  _legacyAssistantRecord(sessionId, channelId, causalRecord) {
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

  async _recordCommittedTurn(state, channel, sourceMessage, causalRecord, legacyUser = null) {
    const output = causalRecord.output;
    const assistantHistoryText = typeof channel.historyAssistantText === 'function'
      ? channel.historyAssistantText(output.text, sourceMessage)
      : output.text;
    if (!this.layeredMemory) {
      return {
        user: legacyUser,
        assistant: this.memory.appendMessage({
          messageId: output.outputId,
          sessionId: state.sessionId,
          channelId: channel.id,
          role: 'assistant',
          text: assistantHistoryText,
          metadata: { causalId: causalRecord.causalId, providerId: output.providerId },
        }).record,
      };
    }
    const sourceMetadata = sourceMessage.metadata || {};
    await this.memory.ensureTurn(sourceMessage.text, assistantHistoryText, {
      causalIds: [causalRecord.causalId],
      sessionId: state.sessionId,
      source: sourceMetadata.source || sourceMetadata.channel || channel.id,
      trustZone: sourceMetadata.trustZone || null,
      chatId: sourceMetadata.chatId || sourceMetadata.telegramChatId || channel.id,
      senderId: sourceMetadata.senderId || sourceMetadata.telegramUserId || null,
      senderEntityId: sourceMetadata.senderEntityId || null,
      senderDisplayName: sourceMetadata.senderDisplayName || null,
      senderIsBot: sourceMetadata.senderIsBot === true,
      owner: sourceMetadata.owner === true,
      groupIngress: sourceMetadata.isGroup === true,
      sentAt: sourceMetadata.sentAt || null,
      receivedAt: causalRecord.input?.receivedAt || sourceMetadata.receivedAt || null,
      completedAt: output.committedAt || null,
      attachmentRefs: sourceMetadata.attachmentRefs || [],
      sourceParts: sourceMessage.sourceParts || [],
      semanticRawMessages: sourceMetadata.semanticRawMessages || [],
      sourceMessageId: sourceMessage.messageId,
      outputMessageId: output.outputId,
      completion: { providerId: output.providerId || null },
    });
    return {
      user: this.memory.messageView({
        messageId: sourceMessage.messageId,
        sessionId: state.sessionId,
        channelId: channel.id,
        role: 'user',
        text: sourceMessage.text,
        metadata: sourceMetadata,
      }),
      assistant: this.memory.messageView({
        messageId: output.outputId,
        sessionId: state.sessionId,
        channelId: channel.id,
        role: 'assistant',
        text: assistantHistoryText,
        metadata: { causalId: causalRecord.causalId, providerId: output.providerId },
      }),
    };
  }

  _checkpoint(sessionId) {
    if (typeof this.session.checkpoint !== 'function') return;
    const result = this.memory.sessionProof(sessionId);
    if (!result.passed) throw new Error(`Memory checkpoint failed: ${result.errors.join(', ')}`);
    this.session.checkpoint(result.proof);
  }

  async _providerMessages(user, sourceMessage = {}) {
    const providerText = sourceMessage.providerText == null
      ? user.text
      : String(sourceMessage.providerText);
    if (this.layeredMemory) {
      const builder = typeof this.memory.buildMessagesAsync === 'function'
        ? this.memory.buildMessagesAsync.bind(this.memory)
        : this.memory.buildMessages.bind(this.memory);
      const messages = (await builder({
        personaPrompt: this.personaPrompt,
        userText: providerText,
        request: {
          trustZone: user.metadata?.trustZone || null,
          chatId: user.metadata?.chatId || user.channelId,
          causalIds: user.metadata?.causalId ? [user.metadata.causalId] : [],
        },
      })).messages;
      const systemPrompt = String(sourceMessage.systemPrompt || '').trim();
      if (systemPrompt) {
        const systemIndex = messages.findIndex((message) => message.role === 'system');
        if (systemIndex >= 0) {
          messages[systemIndex] = {
            ...messages[systemIndex],
            content: `${messages[systemIndex].content}\n\n${systemPrompt}`,
          };
        } else {
          messages.unshift({ role: 'system', content: systemPrompt });
        }
      }
      return messages;
    }
    const compiled = this.memory.compileContext({
      rawTailMessages: this.rawTailMessages,
      summaryLimit: this.summaryLimit,
      cardLimit: this.cardLimit,
    });
    const rawMessages = compiled.rawTail.map((entry) => ({ role: entry.role, content: entry.text }));
    const currentUserIndex = rawMessages.findLastIndex((message) => message.role === 'user');
    if (currentUserIndex >= 0) rawMessages[currentUserIndex].content = providerText;
    const messages = [
      ...(this.personaPrompt ? [{ role: 'system', content: this.personaPrompt }] : []),
      ...compiled.summaries.map((entry) => ({ role: 'system', content: entry.text })),
      ...compiled.cards.map((entry) => ({
        role: 'system',
        content: `[Tether memory card: ${entry.cardType}:${entry.period.key}]\n${entry.content}`,
      })),
      ...rawMessages,
    ];
    const systemPrompt = String(sourceMessage.systemPrompt || '').trim();
    if (systemPrompt) messages.unshift({ role: 'system', content: systemPrompt });
    return messages;
  }

  async _recordObservation(channel, message) {
    const state = await this.session.open({ allowCreate: Boolean(message.allowCreateSession) });
    const causalId = `observation:${channel.id}:${message.messageId}`;
    const metadata = message.metadata || {};
    const observationText = metadata.isGroup
      ? [
          `[Telegram group observation · ${metadata.chatTitle || metadata.chatId || 'group'} · quoted JSON]`,
          JSON.stringify({
            sender: metadata.senderDisplayName || metadata.senderId || 'unknown',
            senderId: metadata.senderId || null,
            messageId: metadata.telegramMessageId || message.messageId,
            text: String(message.text || ''),
          }),
        ].join('\n')
      : message.text;
    if (this.layeredMemory) {
      await this.memory.ensureTurn(observationText, '', {
        causalIds: [causalId],
        sessionId: state.sessionId,
        source: metadata.source || metadata.channel || channel.id,
        trustZone: metadata.trustZone || null,
        chatId: metadata.chatId || channel.id,
        senderId: metadata.senderId || null,
        senderEntityId: metadata.senderEntityId || null,
        senderDisplayName: metadata.senderDisplayName || null,
        senderIsBot: metadata.senderIsBot === true,
        owner: metadata.owner === true,
        groupIngress: metadata.isGroup === true,
        sentAt: metadata.sentAt || null,
        receivedAt: metadata.receivedAt || null,
        attachmentRefs: metadata.attachmentRefs || [],
        sourceParts: message.sourceParts || [],
        semanticRawMessages: metadata.semanticRawMessages || [],
        sourceMessageId: message.messageId,
        ingressOnly: true,
      });
    } else {
      this.memory.appendMessage({
        messageId: message.messageId,
        sessionId: state.sessionId,
        channelId: channel.id,
        role: 'user',
        text: observationText,
        metadata,
      });
    }
    this._checkpoint(state.sessionId);
    await this._maintainMemory();
    return { sessionId: state.sessionId, causalId, observed: true };
  }

  async _maintainMemory() {
    if (!this.layeredMemory || typeof this.memory.maintainOne !== 'function') return;
    if (typeof this.maintenanceSupervisor?.trigger === 'function') {
      this.maintenanceSupervisor.trigger();
      return;
    }
    try {
      await this.memory.maintainOne();
    } catch (error) {
      this.log(`[tether] memory maintenance failed without affecting the committed turn: ${error.message}`);
    }
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
      if (error?.deliveryAmbiguous === true) {
        error.manualRetryOnly = true;
        throw error;
      }
      this.causal.markDeliveryFailed(causalRecord.causalId, error);
      throw error;
    }
    const delivered = this.causal.markDelivered(causalRecord.causalId);
    return { delivered, replayed };
  }

  async handle(channel, message) {
    if (!message?.messageId) throw new Error('Channel message requires a stable messageId');
    if (message.respond === false) return this._recordObservation(channel, message);
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
      const { user, assistant } = await this._recordCommittedTurn(
        state,
        channel,
        message,
        causalRecord,
      );
      this._checkpoint(state.sessionId);
      return {
        sessionId: state.sessionId,
        causalId: causalRecord.causalId,
        user,
        assistant,
        outputId: causalRecord.output.outputId,
        replayed: true,
        alreadyDelivered: true,
      };
    }
    if (['committed', 'delivery-failed'].includes(causalRecord.state)) {
      const { user, assistant } = await this._recordCommittedTurn(
        state,
        channel,
        message,
        causalRecord,
      );
      this._checkpoint(state.sessionId);
      await this._deliver(channel, message, causalRecord, { replayed: true });
      return {
        sessionId: state.sessionId,
        causalId: causalRecord.causalId,
        user,
        assistant,
        outputId: causalRecord.output.outputId,
        replayed: true,
        alreadyDelivered: false,
      };
    }
    if (!['received', 'inference-rejected'].includes(causalRecord.state)) {
      throw new CausalStateError(
        `Unsupported causal state ${causalRecord.state}`,
        'TETHER_CAUSAL_STATE_UNKNOWN',
        { causalId: causalRecord.causalId },
      );
    }

    const user = this.layeredMemory
      ? this.memory.messageView({
          messageId: message.messageId,
          sessionId: state.sessionId,
          channelId: channel.id,
          role: 'user',
          text: message.text,
          metadata: message.metadata || {},
        })
      : this.memory.appendMessage({
          messageId: message.messageId,
          sessionId: state.sessionId,
          channelId: channel.id,
          role: 'user',
          text: message.text,
          metadata: message.metadata || {},
        }).record;
    if (!this.layeredMemory) this._checkpoint(state.sessionId);
    causalRecord = this.causal.markInferenceStarted(causalRecord.causalId);
    const messages = await this._providerMessages({
      ...user,
      metadata: { ...(user.metadata || {}), causalId: causalRecord.causalId },
    }, message);
    let result;
    try {
      result = await this.provider.respond({
        sessionId: state.sessionId,
        channelId: channel.id,
        messages,
        sourceMessage: user,
        sourceParts: message.sourceParts || [],
      });
      if (typeof channel.prepareOutput === 'function') {
        result = await channel.prepareOutput({
          result,
          messages,
          sourceMessage: message,
          respond: (request = {}) => this.provider.respond({
            sessionId: state.sessionId,
            channelId: channel.id,
            ...request,
            sourceParts: request.sourceParts || message.sourceParts || [],
          }),
        });
      }
    } catch (error) {
      if (error?.code === 'TETHER_RESPONSE_CONTRACT_INVALID') {
        this.causal.markInferenceRejected(causalRecord.causalId, {
          reason: error.message,
          text: error.rejectedOutput || '',
          providerId: error.rejectedProviderId || null,
        });
      }
      throw error;
    }
    causalRecord = this.causal.commitOutput(causalRecord.causalId, {
      text: result.text,
      providerId: result.providerId || null,
    });
    const recorded = await this._recordCommittedTurn(
      state,
      channel,
      message,
      causalRecord,
      user,
    );
    const assistant = recorded.assistant;
    this._checkpoint(state.sessionId);
    await this._deliver(channel, message, causalRecord, { replayed: false });
    await this._maintainMemory();
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
