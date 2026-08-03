// SPDX-License-Identifier: Apache-2.0
import './style.css'
import { loadConsole } from './api.js'
import { appMarkup, errorMarkup } from './view.js'

const root = document.querySelector('#app')
const state = {
  page: location.hash.slice(1) || 'overview',
  cardLayer: 'day',
  semanticKind: 'claims',
  selectedCard: null,
}
let data

function render() {
  root.innerHTML = appMarkup(data, state)
  root.querySelectorAll('[data-card-layer]').forEach((button) => {
    button.addEventListener('click', () => {
      state.cardLayer = button.dataset.cardLayer
      state.selectedCard = null
      render()
    })
  })
  root.querySelectorAll('[data-card-id]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedCard = button.dataset.cardId
      render()
    })
  })
  root.querySelectorAll('[data-semantic-kind]').forEach((button) => {
    button.addEventListener('click', () => {
      state.semanticKind = button.dataset.semanticKind
      render()
    })
  })
}

window.addEventListener('hashchange', () => {
  state.page = location.hash.slice(1) || 'overview'
  render()
})

async function bootstrap() {
  try {
    data = await loadConsole()
    render()
  } catch (error) {
    root.innerHTML = errorMarkup(error)
  }
}

bootstrap()
