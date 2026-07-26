export function focusObjectEditControl(testId) {
  requestAnimationFrame(() => {
    for (const element of document.querySelectorAll('[data-cowart-object-edit-focus="true"]')) {
      element.removeAttribute('data-cowart-object-edit-focus')
    }
    const element = document.querySelector(`[data-testid="${testId}"]`)
    element?.setAttribute('data-cowart-object-edit-focus', 'true')
    element?.addEventListener('blur', () => element.removeAttribute('data-cowart-object-edit-focus'), { once: true })
    element?.focus({ preventScroll: true })
  })
}
