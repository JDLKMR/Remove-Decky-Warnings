// Remove Decky Warnings
//
// Frontend-only Decky Loader plugin with no runtime dependencies. It uses the
// globals Decky already exposes to plugins (SP_REACT, SP_JSX, DFL, DeckyBackend).
//
// Decky shows two "third-party" warning dialogs, both rendered by one component
// (WarnThirdParty):
//   - type 1 (ZIP):  installing a plugin from a .zip or URL in Developer settings
//   - type 0 (REPO): selecting the "Custom" plugin store
// Both are gated behind a countdown. The custom store one is also opened from
// inside a component's render body, so it re-opens on every re-render.
//
// How this plugin removes them (several independent layers, because Decky can
// change how it builds / shows the dialog between releases):
//   1. Wraps the element factories Decky's UI is compiled against: SP_JSX.jsx /
//      jsxs / jsxDEV and SP_REACT.createElement. When an element for the warning
//      dialog is created, its component is swapped for one that immediately runs
//      the dialog's onOK handler (exactly what pressing "Continue" does) and
//      closes itself.
//   2. Wraps DFL.showModal, so if the dialog element reaches showModal it is
//      accepted without ever being shown (works even if layer 1 is bypassed).
//   3. As a safety net, sets the "warning already accepted" settings so that, even
//      if the hooks above don't take effect, the countdown is 0 seconds.
//
// Matching is deliberately tolerant: Decky adding or removing props on the dialog
// must not stop it being recognised. Anything that looks close but doesn't match
// is listed in the plugin's panel so a miss can be diagnosed.

type AnyFn = (...args: any[]) => any;

const w = window as any;

const TAG = '[RemoveDeckyWarnings]';
const MARK = '__removeDeckyWarnings';
const ORIGINAL = '__removeDeckyWarningsOriginal';

// Values of Decky's WarnThirdPartyType enum.
const WARN_TYPE_REPO = 0;
const WARN_TYPE_ZIP = 1;

// Props that mean "this is a generic ConfirmModal", not WarnThirdParty.
const GENERIC_MODAL_PROPS = ['strTitle', 'strDescription', 'strOKButtonText', 'strCancelButtonText', 'children'];

// Settings that make Decky use a 0 second countdown (the "already accepted" flags).
const ACCEPTED_SETTINGS = ['developer.warn.third_party', 'store_select.warn.third_party'];

const MAX_UNMATCHED = 5;

const state = {
  active: false,
  hooks: [] as string[],
  skipped: 0,
  unmatched: [] as string[],
  restorers: [] as Array<() => void>,
};

let repoAccepted = false;
let rawCreateElement: AnyFn | null = null;
const replacements = new WeakMap<object, AnyFn>();

function describeProps(props: any): string {
  try {
    return Object.keys(props)
      .map((k) => `${k}:${typeof props[k]}`)
      .join(',');
  } catch {
    return '?';
  }
}

/** Cheap structural check on the props of an element already known to have type 0/1. */
function isThirdPartyWarning(props: any): boolean {
  if (typeof props.onOK !== 'function' || typeof props.onCancel !== 'function') return false;
  // `seconds` may be a number, or absent if Decky stops passing it.
  if (props.seconds !== undefined && typeof props.seconds !== 'number') return false;
  for (const key of GENERIC_MODAL_PROPS) {
    if (key in props) return false;
  }
  return true;
}

function recordUnmatched(props: any): void {
  // Only interesting if it has some callback prop, i.e. could plausibly be a dialog.
  let hasCallback = false;
  for (const key in props) {
    if (typeof props[key] === 'function') {
      hasCallback = true;
      break;
    }
  }
  if (!hasCallback) return;
  const signature = describeProps(props);
  if (state.unmatched.includes(signature) || state.unmatched.length >= MAX_UNMATCHED) return;
  state.unmatched.push(signature);
  console.log(TAG, 'dialog-like element did not match:', signature);
}

/** True if this element is Decky's WarnThirdParty dialog. */
function inspect(type: unknown, props: any): boolean {
  if (props === null || typeof props !== 'object') return false;
  // Fast exit for practically every element in Steam's UI.
  const kind = props.type;
  if (kind !== WARN_TYPE_REPO && kind !== WARN_TYPE_ZIP) return false;
  if (typeof type !== 'function' && (typeof type !== 'object' || type === null)) return false;
  if ((type as any)[MARK]) return false;
  if (isThirdPartyWarning(props)) return true;
  recordUnmatched(props);
  return false;
}

function settle(result: unknown): void {
  if (result && typeof (result as any).then === 'function') {
    (result as Promise<unknown>).catch((e) => console.error(TAG, 'onOK rejected', e));
  }
}

/** Do what pressing "Continue" would do, then close the dialog (if there is one to close). */
function acceptNow(props: any): void {
  try {
    if (props.type === WARN_TYPE_REPO) {
      // For the store warning onOK only records that the warning was accepted, and the
      // dialog gets re-created on every render of the settings page, so do it once.
      if (!repoAccepted) {
        repoAccepted = true;
        settle(props.onOK());
      }
    } else {
      settle(props.onOK());
    }
    state.skipped++;
    console.log(TAG, `skipped ${props.type === WARN_TYPE_REPO ? 'custom store' : 'ZIP install'} warning`);
  } catch (e) {
    console.error(TAG, 'onOK threw', e);
  } finally {
    if (typeof props.closeModal === 'function') {
      try {
        props.closeModal();
      } catch (e) {
        console.error(TAG, 'closeModal threw', e);
      }
    }
  }
}

/** Component that stands in for WarnThirdParty. Renders nothing and accepts + closes immediately. */
function getReplacement(original: object): AnyFn {
  let component = replacements.get(original);
  if (component) return component;

  component = function AutoAcceptWarning(props: any) {
    const React = w.SP_REACT;
    const handled = React.useRef(false);
    const canClose = typeof props.closeModal === 'function';

    React.useLayoutEffect(() => {
      if (!canClose || handled.current) return;
      handled.current = true;
      if (props.type === WARN_TYPE_REPO) {
        // Close before the first paint so the store dialog never visibly flashes.
        acceptNow(props);
      } else {
        // Let the dialog finish mounting first, then run the install action (opens the file picker).
        setTimeout(() => acceptNow(props), 0);
      }
    }, []);

    // If we can't close the dialog, never leave an empty modal on screen. Show the original
    // dialog instead, with the countdown at 0 so Continue is available immediately. This must
    // bypass our own createElement hook, or it would just be swapped for this component again.
    if (!canClose) return (rawCreateElement ?? React.createElement)(original, { ...props, seconds: 0 });
    return null;
  };
  (component as any)[MARK] = true;
  replacements.set(original, component);
  return component;
}

function setProp(target: any, name: string, value: unknown): boolean {
  try {
    target[name] = value;
  } catch {
    /* fall through */
  }
  if (target[name] === value) return true;
  try {
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: true });
  } catch {
    /* ignore */
  }
  return target[name] === value;
}

/** Wrap an element factory (jsx / jsxs / jsxDEV / createElement): (type, props, ...) => element. */
function hookFactory(target: any, name: string, label: string): boolean {
  if (!target) return false;
  const current = target[name];
  if (typeof current !== 'function') return false;

  // If a stale wrapper from an earlier load is still installed, unwrap it so they don't stack.
  const base: AnyFn = current[ORIGINAL] ?? current;

  const wrapped = function (this: unknown, type: unknown, props: any) {
    if (state.active && inspect(type, props)) {
      const args = Array.prototype.slice.call(arguments);
      args[0] = getReplacement(type as object);
      return base.apply(this, args);
    }
    return base.apply(this, arguments as any);
  };
  (wrapped as any)[ORIGINAL] = base;

  if (!setProp(target, name, wrapped)) return false;
  state.hooks.push(label);
  state.restorers.push(() => {
    // Only put the original back if nobody else has wrapped us since.
    if (target[name] === wrapped) setProp(target, name, base);
  });
  return true;
}

/** Wrap DFL.showModal so a warning element is accepted without ever being shown. */
function hookShowModal(): boolean {
  const dfl = w.DFL;
  if (!dfl) return false;
  const current = dfl.showModal;
  if (typeof current !== 'function') return false;

  const base: AnyFn = current[ORIGINAL] ?? current;

  const wrapped = function (this: unknown, modal: any) {
    if (state.active && modal !== null && typeof modal === 'object' && inspect(modal.type, modal.props)) {
      const props = modal.props;
      // Never run the handler inside a render pass; Decky can call showModal from one.
      setTimeout(() => acceptNow({ ...props, closeModal: undefined }), 0);
      return { Close() {}, Update() {} };
    }
    return base.apply(this, arguments as any);
  };
  (wrapped as any)[ORIGINAL] = base;

  if (!setProp(dfl, 'showModal', wrapped)) return false;
  state.hooks.push('DFL.showModal');
  state.restorers.push(() => {
    if (dfl.showModal === wrapped) setProp(dfl, 'showModal', base);
  });
  return true;
}

/** Mark both warnings as already accepted so the countdown is 0 even without the hooks. */
async function seedAcceptedFlags(): Promise<void> {
  const backend = w.DeckyBackend;
  if (!backend || typeof backend.call !== 'function') return;
  for (const key of ACCEPTED_SETTINGS) {
    try {
      const current = await backend.call('utilities/settings/get', key, false);
      if (current !== true) await backend.call('utilities/settings/set', key, true);
    } catch (e) {
      console.error(TAG, `could not set ${key}`, e);
    }
  }
}

function install(): void {
  // Undo a previous instance that was never dismounted (e.g. a forced reload).
  if (typeof w.__removeDeckyWarningsRestore === 'function') {
    try {
      w.__removeDeckyWarningsRestore();
    } catch {
      /* ignore */
    }
  }

  state.active = true;
  state.hooks = [];
  state.unmatched = [];

  // Remember the untouched createElement before hooking it (see getReplacement).
  const create = w.SP_REACT?.createElement;
  rawCreateElement = typeof create === 'function' ? create[ORIGINAL] ?? create : null;

  for (const name of ['jsx', 'jsxs', 'jsxDEV']) hookFactory(w.SP_JSX, name, `SP_JSX.${name}`);
  hookFactory(w.SP_REACT, 'createElement', 'SP_REACT.createElement');
  hookShowModal();

  w.__removeDeckyWarningsRestore = uninstall;

  if (state.hooks.length === 0) {
    console.warn(TAG, 'could not hook anything; only the countdowns are being removed');
  } else {
    console.log(TAG, `hooked ${state.hooks.join(', ')}`);
  }
  void seedAcceptedFlags();
}

function uninstall(): void {
  state.active = false;
  for (const restore of state.restorers.splice(0)) {
    try {
      restore();
    } catch {
      /* ignore */
    }
  }
  if (w.__removeDeckyWarningsRestore === uninstall) delete w.__removeDeckyWarningsRestore;
}

function StatusPanel() {
  const React = w.SP_REACT;
  const { PanelSection, PanelSectionRow } = w.DFL;
  const rows = [
    React.createElement(
      PanelSectionRow,
      { key: 'info' },
      React.createElement(
        'div',
        { style: { fontSize: '12px', lineHeight: '1.4' } },
        "Decky's third-party plugin install warning and custom store warning are skipped while this plugin is enabled.",
      ),
    ),
    React.createElement(
      PanelSectionRow,
      { key: 'status' },
      React.createElement(
        'div',
        { style: { fontSize: '12px', opacity: 0.7 } },
        state.hooks.length > 0
          ? `Hooks active: ${state.hooks.join(', ')}`
          : 'Hooks: none (countdown removal only)',
        React.createElement('br', null),
        `Warnings skipped this session: ${state.skipped}`,
      ),
    ),
  ];
  if (state.unmatched.length > 0) {
    rows.push(
      React.createElement(
        PanelSectionRow,
        { key: 'unmatched' },
        React.createElement(
          'div',
          { style: { fontSize: '11px', opacity: 0.7, wordBreak: 'break-all' } },
          'Dialog-like elements that were NOT matched (props):',
          ...state.unmatched.flatMap((s) => [React.createElement('br', null), s]),
        ),
      ),
    );
  }
  return React.createElement(PanelSection, null, ...rows);
}

function Icon() {
  const React = w.SP_REACT;
  return React.createElement(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: '1em',
      height: '1em',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { display: 'block' },
    },
    React.createElement('path', { d: 'M12 3 2 20h20L12 3z' }),
    React.createElement('path', { d: 'M12 10v4' }),
    React.createElement('path', { d: 'M12 17.5v.01' }),
    React.createElement('path', { d: 'M3 3l18 18' }),
  );
}

export default function plugin() {
  install();
  const React = w.SP_REACT;
  return {
    name: 'Remove Decky Warnings',
    content: React.createElement(StatusPanel, null),
    icon: React.createElement(Icon, null),
    onDismount() {
      uninstall();
    },
  };
}

// Exposed for testing only; Decky only uses the default export.
export const __internals = { inspect, getReplacement, acceptNow, hookFactory, hookShowModal, state, install, uninstall };
