export const ONBOARDING_DISMISSED_KEY = 'cowart-onboarding-dismissed'

const IS_ZH = typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('zh')

const ONBOARDING_COPY = IS_ZH
  ? {
      title: '欢迎使用 Cowart 画布',
      subtitle: '这是你和 Codex 共享的无限画布。',
      items: [
        ['A', '按 A 或从工具栏拖出「AI 图片」框，让 Codex 生成图片填入'],
        ['C', '按 C 批注图片，让 Codex 按批注生成修订图'],
        ['✎', '让 Codex 在画布上作图（流程图、标注），或把结果导出为图片']
      ],
      dismiss: '开始使用'
    }
  : {
      title: 'Welcome to the Cowart canvas',
      subtitle: 'An infinite canvas you share with Codex.',
      items: [
        ['A', 'Press A (or drag from the toolbar) to add an AI image holder, then ask Codex to fill it'],
        ['C', 'Press C to annotate an image, then ask Codex to generate a revision'],
        ['✎', 'Ask Codex to draw shapes (flowcharts, labels) or export the canvas as an image']
      ],
      dismiss: 'Get started'
    }

const TOAST_COPY = IS_ZH
  ? { label: (n) => `Codex 更新了画布 · ${n} 个新图形`, locate: '查看', dismiss: '关闭' }
  : { label: (n) => `Codex updated the canvas · ${n} new shape${n === 1 ? '' : 's'}`, locate: 'Show', dismiss: 'Dismiss' }

export function readOnboardingDismissed() {
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function CowartEmptyOverlay({ onDismiss }) {
  return (
    <div className="cowart-empty">
      <div className="cowart-empty-card" role="dialog" aria-label={ONBOARDING_COPY.title}>
        <h1 className="cowart-empty-title">{ONBOARDING_COPY.title}</h1>
        <p className="cowart-empty-subtitle">{ONBOARDING_COPY.subtitle}</p>
        <ul className="cowart-empty-list">
          {ONBOARDING_COPY.items.map(([key, text]) => (
            <li key={key} className="cowart-empty-item">
              <span className="cowart-empty-key">{key}</span>
              <span>{text}</span>
            </li>
          ))}
        </ul>
        <button className="cowart-empty-dismiss" type="button" onClick={onDismiss}>
          {ONBOARDING_COPY.dismiss}
        </button>
      </div>
    </div>
  )
}

export function CowartAgentToast({ activity, onLocate, onDismiss }) {
  return (
    <div className="cowart-toast" role="status" aria-live="polite">
      <span className="cowart-toast-dot" aria-hidden="true" />
      <span className="cowart-toast-text">{TOAST_COPY.label(activity.count)}</span>
      <button className="cowart-toast-btn" type="button" onClick={onLocate}>
        {TOAST_COPY.locate}
      </button>
      <button className="cowart-toast-close" type="button" aria-label={TOAST_COPY.dismiss} onClick={onDismiss}>
        ×
      </button>
    </div>
  )
}
