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
// How this plugin removes them:
//   1. Wraps SP_JSX.jsx / SP_JSX.jsxs (the JSX runtime Decky's own UI is
//      compiled against). When an element for the warning dialog is created, its
//      component is swapped for one that immediately runs the dialog's onOK
//      handler (exactly what pressing "Continue" does) and closes itself.
//   2. As a safety net, sets the "warning already accepted" settings so that, even
//      if the hook above doesn't take effect, the countdown is 0 seconds.

type AnyFn = (...args: any[]) => any;

const w = window as any;

const TAG = '[RemoveDeckyWarnings]';
const MARK = '__removeDeckyWarnings';
const ORIGINAL = '__removeDeckyWarningsOriginal';

// Values of Decky's WarnThirdPartyType enum.
const WARN_TYPE_REPO = 0;
const WARN_TYPE_ZIP = 1;

// Exactly the props Decky passes to WarnThirdParty (closeModal is injected by showModal).
const WARN_PROP_KEYS = new Set(['seconds', 'type', 'onOK', 'onCancel', 'closeModal']);

// Settings that make Decky use a 0 second countdown (the "already accepted" flags).
const ACCEPTED_SETTINGS = ['developer.warn.third_party', 'store_select.warn.third_party'];

const state = {
  active: false,
  hooked: [] as string[],
  skipped: 0,
  restorers: [] as Array<() => void>,
};

let repoAccepted = false;
const replacements = new WeakMap<AnyFn, AnyFn>();

/** True if this element is Decky's WarnThirdParty dialog. Kept strict on purpose. */
function isThirdPartyWarning(type: unknown, props: any): boolean {
  if (typeof type !== 'function' || props === null || typeof props !== 'object') return false;
  if (typeof props.seconds !== 'number') return false;
  if (props.type !== WARN_TYPE_REPO && props.type !== WARN_TYPE_ZIP) return false;
  if (typeof props.onOK !== 'function' || typeof props.onCancel !== 'function') return false;
  for (const key in props) {
    if (!WARN_PROP_KEYS.has(key)) return false;
  }
  return !(type as any)[MARK];
}

function settle(result: unknown): void {
  if (result && typeof (result as any).then === 'function') {
    (result as Promise<unknown>).catch((e) => console.error(TAG, 'onOK rejected', e));
  }
}

/** Do what pressing "Continue" would do, then close the dialog. */
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
  } catch (e) {
    console.error(TAG, 'onOK threw', e);
  } finally {
    try {
      props.closeModal();
    } catch (e) {
      console.error(TAG, 'closeModal threw', e);
    }
  }
}

/** Component that stands in for WarnThirdParty. Renders nothing and accepts + closes immediately. */
function getReplacement(original: AnyFn): AnyFn {
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
    // dialog instead, with the countdown at 0 so Continue is available immediately.
    if (!canClose) return React.createElement(original, { ...props, seconds: 0 });
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

/** Wrap SP_JSX.jsx / SP_JSX.jsxs. Returns the names that were hooked. */
function hookJsxRuntime(): string[] {
  const runtime = w.SP_JSX;
  const hooked: string[] = [];
  if (!runtime) return hooked;

  for (const name of ['jsx', 'jsxs']) {
    const current = runtime[name];
    if (typeof current !== 'function') continue;

    // If a stale wrapper from an earlier load is still installed, unwrap it so they don't stack.
    const base: AnyFn = current[ORIGINAL] ?? current;

    const wrapped = function (this: unknown, type: unknown, props: any) {
      if (state.active && typeof props === 'object' && props !== null && typeof props.seconds === 'number') {
        if (isThirdPartyWarning(type, props)) {
          const args = Array.prototype.slice.call(arguments);
          args[0] = getReplacement(type as AnyFn);
          return base.apply(this, args);
        }
      }
      return base.apply(this, arguments as any);
    };
    (wrapped as any)[ORIGINAL] = base;

    if (setProp(runtime, name, wrapped)) {
      hooked.push(name);
      state.restorers.push(() => {
        // Only put the original back if nobody else has wrapped us since.
        if (runtime[name] === wrapped) setProp(runtime, name, base);
      });
    }
  }
  return hooked;
}

/** Mark both warnings as already accepted so the countdown is 0 even without the hook. */
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
  state.hooked = hookJsxRuntime();
  w.__removeDeckyWarningsRestore = uninstall;

  if (state.hooked.length === 0) {
    console.warn(TAG, 'could not hook the JSX runtime; only the countdowns are being removed');
  } else {
    console.log(TAG, `hooked ${state.hooked.join(', ')}`);
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
  const hooked = state.hooked.length > 0;
  return React.createElement(
    PanelSection,
    null,
    React.createElement(
      PanelSectionRow,
      null,
      React.createElement(
        'div',
        { style: { fontSize: '12px', lineHeight: '1.4' } },
        "Decky's third-party plugin install warning and custom store warning are skipped while this plugin is enabled.",
      ),
    ),
    React.createElement(
      PanelSectionRow,
      null,
      React.createElement(
        'div',
        { style: { fontSize: '12px', opacity: 0.7 } },
        hooked ? 'Dialog hook: active' : 'Dialog hook: not active (countdown removal only)',
        React.createElement('br', null),
        `Warnings skipped this session: ${state.skipped}`,
      ),
    ),
  );
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
export const __internals = { isThirdPartyWarning, getReplacement, acceptNow, hookJsxRuntime, state, install, uninstall };
