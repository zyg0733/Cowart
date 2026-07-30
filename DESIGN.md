# Cowart Design System

## 1. Foundations

Cowart is a compact operational canvas shared by a human and Codex. The visual system should keep the infinite canvas primary, with overlays acting as quiet instruments: small, direct, and dismissible. The existing product language is warm paper, dark ink, cyan action, restrained status color, and tldraw-native controls with Cowart additions layered in only where the agent workflow needs them.

Current foundations extracted from `src/styles.css`, `src/App.jsx`, and `src/CowartAiImageShape.jsx`:

| Role | Token | Current value | Usage |
| --- | --- | --- | --- |
| App shell | `--cowart-canvas-fixed` | `position: fixed; inset: 0` | The canvas fills the viewport with no page scroll. |
| Background | `--cowart-surface-canvas` | `#f7f5ef` | Warm paper body behind tldraw. |
| Primary ink | `--cowart-ink` | `#1f2430` | Body text, controls, dense status copy. |
| Muted ink | `--cowart-ink-muted` | `#4a5568` | Secondary state text and loading/error shell text. |
| Soft ink | `--cowart-ink-soft` | `#8a93a3` | Hints and quiet metadata. |
| Font stack | `--cowart-font-sans` | `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | All Cowart overlay and holder UI. |
| Base sizing unit | `--cowart-unit` | `4px` | Spacing, radius, and compact control rhythm. |

Object-aware editing must preserve this foundation. It is a canvas tool, not a redesign: the future overlay should sit above selected image content, reuse existing fixed viewport and tldraw selection behavior, and avoid candidate tldraw shapes. Candidate segmentation state is ephemeral UI; confirmed segment summaries belong to the Segment Store and selection/MCP output.

## 2. Color and Elevation

The current palette is intentionally small. Cyan identifies Cowart-specific action, amber means queued or pending, red means failure or destructive action, white creates readable elevated overlays, and dark ink provides contrast. New object-edit tokens must alias these roles.

| Role | Token | Current value | Usage |
| --- | --- | --- | --- |
| Accent action | `--cowart-accent` | `#25bfef` | Primary Cowart action, empty holder outline, active object-edit affordance. |
| Accent hover | `--cowart-accent-hover` | `#1aa9d6` | Hover state for primary Cowart actions. |
| Accent text | `--cowart-accent-ink` | `#087596` | Generating/segmenting status text. |
| Accent wash | `--cowart-accent-wash` | `rgba(37, 191, 239, 0.12)` | Keycaps, selection overlays, object mask preview tint at low opacity. |
| Accent outline | `--cowart-accent-outline` | `rgba(37, 191, 239, 0.45)` | Empty holder and object-edit preview outline. |
| Pending | `--cowart-pending` | `#ff9f0a` | Queued/requested/pending object-edit states. |
| Pending ink | `--cowart-pending-ink` | `#7a4b00` | Pending status chip text. |
| Pending wash | `--cowart-pending-wash` | `rgba(255, 247, 232, 0.96)` | Requested chip background. |
| Danger | `--cowart-danger` | `#d64738` | Failed states, destructive cancel/delete affordances. |
| Danger hover | `--cowart-danger-hover` | `#b93627` | Hover for destructive action. |
| Danger ink | `--cowart-danger-ink` | `#9f2d20` | Error copy. |
| Danger wash | `--cowart-danger-wash` | `rgba(255, 241, 239, 0.96)` | Failure chip background. |
| Elevated surface | `--cowart-surface-elevated` | `rgba(255, 255, 255, 0.96)` | Onboarding card, chips, compact object-edit panels. |
| Dark surface | `--cowart-surface-inverse` | `rgba(31, 36, 48, 0.94)` | Agent toast and high-priority transient notices. |
| Hairline border | `--cowart-border` | `rgba(31, 36, 48, 0.1)` | Cards and elevated overlay separation. |
| Strong hairline | `--cowart-border-strong` | `rgba(31, 36, 48, 0.14)` | Status chips and white ghost buttons. |
| Raised shadow | `--cowart-shadow-raised` | `0 18px 48px rgba(31, 36, 48, 0.18)` | Dialog-like elevated card. |
| Toast shadow | `--cowart-shadow-toast` | `0 10px 30px rgba(31, 36, 48, 0.28)` | Bottom activity toast. |
| Chip shadow | `--cowart-shadow-chip` | `0 4px 12px rgba(31, 36, 48, 0.12)` | Holder/object status chips. |

Object-edit overlay state mapping:

| State | Color tokens | Elevation pattern |
| --- | --- | --- |
| Idle | `--cowart-ink-muted`, `--cowart-border` | No panel unless a filled image is selected. |
| Loading and segmenting | `--cowart-accent`, `--cowart-accent-ink`, `--cowart-accent-wash` | Compact elevated chip plus mask-progress overlay. |
| Preview | `--cowart-accent`, `--cowart-accent-outline`, `--cowart-accent-wash` | Mask tint over image, handles/actions elevated but not card-heavy. |
| Confirmed | `--cowart-accent-hover`, `--cowart-surface-elevated` | Small persistent summary chip joined to selection UI. |
| Cancel and retry | `--cowart-ink`, `--cowart-surface-elevated`, `--cowart-border-strong` | Ghost control style. |
| Stale and error | `--cowart-danger`, `--cowart-danger-ink`, `--cowart-danger-wash` | Error chip and retry/cancel actions, no silent success color. |
| Unsupported/checksum failure | `--cowart-pending-ink` or `--cowart-danger-ink` depending severity | Honest status panel; do not show a fake preview. |

## 3. Typography

Typography is compact and utilitarian. Existing Cowart UI uses small dense labels around the canvas and delegates broad drawing/editor typography to tldraw.

| Role | Token | Current value | Usage |
| --- | --- | --- | --- |
| Title compact | `--cowart-type-title` | `18px / normal, 650` | Empty-canvas title only. |
| Body compact | `--cowart-type-body` | `13px / 1.45, 400` | Onboarding list, toast text, toolbar label, object-edit body copy. |
| Label compact | `--cowart-type-label` | `13px / 1, 500-650` | Toolbar labels, holder labels, primary button text. |
| Control small | `--cowart-type-control` | `12px / 1, 600` | Toast and holder action buttons. |
| Chip | `--cowart-type-chip` | `11px / 1.2, 700` | Status chips. |
| Hint | `--cowart-type-hint` | `11px / 1.25, 400-600` | Holder hints and errors. |

Rules:

| Rule | Contract |
| --- | --- |
| Font family | Use `--cowart-font-sans`; do not introduce display fonts for operational overlays. |
| Scale | Object-edit controls use `11px`, `12px`, or `13px` only unless a full dialog is introduced and documented first. |
| Weight | Use 600-700 for controls/status and 400-500 for explanatory text. |
| Wrapping | CJK and long prompt/error text must use normal wrapping, `overflow-wrap: anywhere` where needed, and avoid negative letter spacing. |
| Truncation | Status chips may ellipsize; errors and prompts may clamp only when the full text is available through accessible name/description or a detail view. |

## 4. Spacing and Layout

Cowart spacing follows a 4px base with dense operational grouping. Existing overlays use fixed canvas placement, small gaps, pill controls, and compact cards.

| Token | Current value | Usage |
| --- | --- | --- |
| `--cowart-space-1` | `4px` | Tight button/action gaps and divider margin. |
| `--cowart-space-2` | `8px` | Chip inset, editor inset, compact panel padding. |
| `--cowart-space-3` | `12px` | Holder placeholder padding, list item gap, toolbar button padding. |
| `--cowart-space-4` | `16px` | Button horizontal padding, onboarding subtitle/list rhythm. |
| `--cowart-space-5` | `20px` | Onboarding list-to-action gap. |
| `--cowart-space-6` | `24px` | Viewport overlay padding. |
| `--cowart-space-7` | `28px` | Onboarding horizontal card padding. |
| `--cowart-radius-sm` | `8px` | Keycaps and inline editors. |
| `--cowart-radius-md` | `10px` | Holder body and small buttons. |
| `--cowart-radius-lg` | `16px` | Existing onboarding card. |
| `--cowart-radius-pill` | `999px` | Toasts, chips, primary/ghost holder buttons. |

Layout rules:

| Surface | Contract |
| --- | --- |
| Canvas | `.cowart-canvas` remains full-viewport and scroll-free. Object-edit UI must not add page layout or landing-page composition. |
| Toolbar | Custom Cowart tools fit inside the tldraw toolbar, use icon-first affordances, and remain stable under overflow. |
| Onboarding | A single elevated card is allowed for first-run empty state only. |
| Toast | Bottom-center, short-lived, non-modal, and no wider than its text/actions require. |
| Holder actions | Bottom-right, wrap within shape bounds, visible on hover/focus and always visible on touch. |
| Object-edit overlay | Anchor to the selected filled image and/or viewport edge; do not cover unrelated canvas controls. Preview controls must remain stable at 375px, 768px, and 1280px widths. |
| Hit targets | Any new object-edit button, mode toggle, point/scribble selector, accept, cancel, or retry control must have at least a 44px by 44px interactive target, even when the visual pill is smaller. |

## 5. Components and Controls

Current reusable primitives:

| Component | Structure | Tokens and states |
| --- | --- | --- |
| Canvas status | `<main class="cowart-status" aria-live="polite">` | Centered full viewport, `--cowart-ink-muted`, loading/error copy. |
| Main canvas shell | `<main class="cowart-canvas" aria-label="Cowart infinite canvas">` with `<Tldraw />` | Fixed full viewport, tldraw owns base canvas and default UI. |
| Cowart toolbar item | tldraw `TldrawUiMenuToolItem` or custom `<button class="tlui-button__tool cowart-annotation-toolbar-button">` | Uses tldraw button language, `aria-pressed`, `data-testid`, icon plus compact label when needed. |
| Toolbar divider | `<div role="separator" aria-orientation="vertical">` | 1px hairline, 22px height, neutral gray. |
| Empty overlay | `.cowart-empty` with `.cowart-empty-card` | Pointer passthrough shell, elevated white card, compact intro copy, cyan dismiss button. |
| Agent toast | `.cowart-toast` with status text and actions | Dark inverse pill, `role="status"`, cyan activity dot, white action button, close affordance. |
| AI image holder | Custom `cowart-ai-image` tldraw shape | Filled image or placeholder; statuses `empty`, `requested`, `generating`, `failed`, `filled`; status chip, spinner, prompt editor, action buttons. |
| Holder action button | `.cowart-ai-image__btn` variants primary, ghost, danger | Primary cyan, ghost white, danger red; focus-visible outline; min-width 44px. |
| Holder prompt editor | `.cowart-ai-image__editor` textarea | White elevated editor inside the shape, cyan focus outline, Escape closes. |

Object-edit additions to document before implementation:

| Component | Required structure | Token/state contract |
| --- | --- | --- |
| Object-edit tool button | tldraw toolbar item with `data-testid="object-edit.tool"` | Reuse tldraw tool button sizing and selected state; icon-first; text only if overflow-safe. |
| Object-edit overlay | `data-testid="object-edit.overlay"` anchored over selected image | Mask preview tint uses `--cowart-accent-wash`; outline uses `--cowart-accent-outline`; never creates candidate shapes. |
| Object-edit status | `data-testid="object-edit.status"` with `aria-live="polite"` | Uses chip type; states idle/loading/segmenting/preview/confirmed/cancelled/retry/stale/error/unsupported. |
| Loading indicator | `data-testid="object-edit.loading"` | Reuse spinner timing and cyan border; reduced motion falls back to static ring. |
| Error notice | `data-testid="object-edit.error"` | Danger ink/wash; expose actionable retry/cancel, never ambiguous success. |
| Accept/cancel/retry controls | `data-testid="object-edit.accept"`, `data-testid="object-edit.cancel"`, `data-testid="object-edit.retry"` | Minimum 44px targets, visible focus rings, Enter accepts preview, Escape cancels candidate/inference. |
| Point/scribble input modes | Segmented icon or compact toggle group | Mode state is explicit; point and scribble both map to normalized image coordinates. |

## 6. Interaction and State

Interaction is direct and stateful, with no hidden background automation. Current patterns:

| Pattern | Existing behavior |
| --- | --- |
| Tool activation | Toolbar button or keyboard shortcut selects the tool; annotation uses `C`, AI image holder uses `A`. |
| Pointer work | Annotation starts on pointer down, updates during move, completes on pointer up, and cancels through tldraw interruption/cancel. |
| Request lifecycle | AI image holder actions set `requested`, `generating`, `failed`, or `filled` states through shape props/meta. |
| Live status | Loading shell and toast use `aria-live="polite"`; holder requested/generating/failed chips use `role="status"`. |
| Escape | Annotation cancel and holder prompt editing both support Escape. |
| Focus | Cowart buttons use native buttons; holder buttons have visible focus outline. |
| Motion | Existing spinner rotates at `0.8s linear`; holder actions fade opacity over `0.12s ease`. Agent locate zoom uses 320ms tldraw animation. |

Object-edit interaction contract:

| State | Expected interaction |
| --- | --- |
| Idle | Enabled only for one selected filled image with resolvable source pixels. |
| Loading | Fetch/initialize model or segment metadata; controls stay cancellable. |
| Segmenting | Point or scribble input is captured in image coordinates; late Worker results after cancel are ignored. |
| Preview | Shows a nonempty mask overlay and accept/cancel/retry controls; Enter accepts, Escape cancels. |
| Confirmed | Confirmed Segment Store summary appears in selection/UI and survives reload. |
| Stale | Source hash mismatch blocks confirm/refine/writeback and offers retry after reload. |
| Error | Shows structured message, retry if recoverable, cancel always available. |
| Unsupported | Explains missing browser capability without fake segmentation or cloud fallback. |

Reduced-motion rule: respect `prefers-reduced-motion`. Disable nonessential opacity transitions, stop spinner rotation in favor of a static progress/status mark, and use immediate camera movement when motion reduction is active.

## 7. Accessibility and Responsive Behavior

Cowart’s accessibility baseline is native controls, compact readable copy, and tldraw integration. New object-edit UI must keep the same operational density while making every state keyboard and screen-reader reachable.

| Requirement | Contract |
| --- | --- |
| Landmarks | Keep the main canvas in `<main aria-label="Cowart infinite canvas">`; modal-like onboarding keeps `role="dialog"` and a label. |
| Live regions | Loading, segmenting, preview-ready, confirmed, stale, and error statuses use `aria-live="polite"` unless an operation blocks immediate user safety. |
| Keyboard | Object-edit tool can be reached from toolbar; Enter accepts a preview; Escape cancels inference/preview; Tab order moves through mode, accept, cancel, retry without trapping unless a true modal is introduced. |
| Targets | All actionable object-edit controls have at least 44px by 44px hit areas on touch and pointer devices. |
| Focus | Use visible `:focus-visible` outlines with ink or cyan contrast; do not rely on color-only state. |
| Contrast | Text on white/elevated surfaces uses `--cowart-ink` or state ink tokens; mask tint must not make control labels unreadable. |
| CJK | Chinese and other CJK strings must wrap cleanly in compact panels; avoid fixed-width English assumptions, negative tracking, and single-line-only critical instructions. |
| Responsive | At 375px, object-edit controls may stack or dock but must not overlap tldraw toolbar, bottom toast, or selected image critical content. At 768px and 1280px, keep controls close to the selected image and preserve canvas workspace. |
| Touch | Hover-revealed actions must also be visible or reachable on `hover: none`, matching the existing holder action pattern. |
| Generated media | Fixture/test images and object previews need meaningful alt text or accessible labels when rendered as HTML images; mask-only visuals need textual status. |
