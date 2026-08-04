// SPDX-License-Identifier: Apache-2.0
import './style.css'
import { loadConsole } from './api.js'
import {
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  preferredLocale,
  t,
} from './i18n.js'
import { appMarkup, errorMarkup, loadingMarkup } from './view.js'

const root = document.querySelector('#app')

function readStoredLocale() {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredLocale(locale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // The interface still switches when storage is unavailable.
  }
}

const initialLocale = preferredLocale({
  stored: readStoredLocale(),
  languages: navigator.languages?.length ? navigator.languages : [navigator.language],
})

const state = {
  page: location.hash.slice(1) || 'overview',
  locale: initialLocale,
  cardLayer: 'day',
  cardMonths: {},
  cardPeriods: {},
  semanticKind: 'claims',
  selectedCard: null,
}
let data

function updateDocumentLanguage() {
  document.documentElement.lang = state.locale
  document.title = t(state.locale, 'app.title')
  document.querySelector('meta[name="description"]')?.setAttribute(
    'content',
    t(state.locale, 'app.description'),
  )
}

function wireInteractions() {
  root.querySelectorAll('[data-locale]').forEach((button) => {
    button.addEventListener('click', () => {
      const locale = normalizeLocale(button.dataset.locale)
      if (!locale || locale === state.locale) return
      state.locale = locale
      writeStoredLocale(locale)
      updateDocumentLanguage()
      render()
    })
  })
  root.querySelectorAll('[data-card-layer]').forEach((button) => {
    button.addEventListener('click', () => {
      state.cardLayer = button.dataset.cardLayer
      state.selectedCard = null
      render()
    })
  })
  root.querySelectorAll('[data-calendar-month]').forEach((button) => {
    button.addEventListener('click', () => {
      const month = button.dataset.calendarMonth
      if (!month) return
      state.cardMonths[state.cardLayer] = month
      state.cardPeriods[state.cardLayer] = null
      state.selectedCard = null
      render()
    })
  })
  root.querySelectorAll('[data-calendar-period]').forEach((button) => {
    button.addEventListener('click', () => {
      state.cardPeriods[state.cardLayer] = button.dataset.calendarPeriod
      state.selectedCard = null
      render()
    })
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        state.cardPeriods[state.cardLayer] = button.dataset.calendarPeriod
        state.selectedCard = null
        render()
        return
      }
      const buttons = [...root.querySelectorAll('[data-calendar-period]')]
      const index = buttons.indexOf(button)
      if (index < 0) return
      let destination = null
      if (event.key === 'Home') {
        destination = buttons.findIndex((item) => !item.disabled)
      } else if (event.key === 'End') {
        for (let cursor = buttons.length - 1; cursor >= 0; cursor -= 1) {
          if (!buttons[cursor].disabled) {
            destination = cursor
            break
          }
        }
      } else {
        const step = {
          ArrowLeft: -1,
          ArrowUp: -7,
          ArrowRight: 1,
          ArrowDown: 7,
        }[event.key]
        if (!step) return
        for (let cursor = index + step; cursor >= 0 && cursor < buttons.length; cursor += step) {
          if (!buttons[cursor].disabled) {
            destination = cursor
            break
          }
        }
      }
      if (destination === null || destination < 0) return
      event.preventDefault()
      buttons[destination].focus()
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

function render() {
  if (!data) return
  root.innerHTML = appMarkup(data, state)
  wireInteractions()
}

window.addEventListener('hashchange', () => {
  state.page = location.hash.slice(1) || 'overview'
  render()
})

async function bootstrap() {
  updateDocumentLanguage()
  root.innerHTML = loadingMarkup(state.locale)
  try {
    data = await loadConsole()
    render()
  } catch (error) {
    root.innerHTML = errorMarkup(error, state.locale)
  }
}

bootstrap()
