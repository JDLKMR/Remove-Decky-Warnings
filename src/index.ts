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
//   4. Self-healing: other code (another plugin, Decky itself) can overwrite the
//      functions hooked in 1 and 2, silently switching the plugin off until it is
//      reloaded. A watchdog therefore probes the hooks twice a second and
//      re-installs any that stopped working, and re-applies the settings in 3
//      every so often. Every repair is recorded and shown in the plugin's panel.
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
const MAX_EVENTS = 6;
const WATCHDOG_MS = 500;
const RESEED_EVERY_TICKS = 120; // ~60 s
const MAX_SHOWMODAL_REWRAPS = 5;

const state = {
  active: false,
  hooks: [] as string[],
  skipped: 0,
  repairs: 0,
  ticks: 0,
  unmatched: [] as string[],
  events: [] as string[],
  restorers: [] as Array<() => void>,
  timer: null as number | null,
};

interface FactoryDef {
  label: string;
  name: string;
  target: () => any;
}

// Element factories Decky's UI may be compiled against. Targets are looked up fresh each
// time, in case a whole global object gets replaced.
const FACTORIES: FactoryDef[] = [
  { label: 'SP_JSX.jsx', name: 'jsx', target: () => w.SP_JSX },
  { label: 'SP_JSX.jsxs', name: 'jsxs', target: () => w.SP_JSX },
  { label: 'SP_JSX.jsxDEV', name: 'jsxDEV', target: () => w.SP_JSX },
  { label: 'SP_REACT.createElement', name: 'createElement', target: () => w.SP_REACT },
];

const showModalHook = { target: null as any, wrapped: null as AnyFn | null, rewraps: 0 };

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

function logEvent(message: string): void {
  const stamp = new Date().toLocaleTimeString();
  state.events.push(`${stamp} ${message}`);
  if (state.events.length > MAX_EVENTS) state.events.shift();
  console.warn(TAG, message);
}

function setHook(label: string, installed: boolean): void {
  const index = state.hooks.indexOf(label);
  if (installed && index === -1) state.hooks.push(label);
  if (!installed && index !== -1) state.hooks.splice(index, 1);
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
function wrapFactory(target: any, name: string): boolean {
  const current = target[name];
  if (typeof current !== 'function') return false;

  // Unwrap one of our own earlier wrappers so they don't stack.
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
  state.restorers.push(() => {
    // Only put the original back if nobody else has wrapped us since.
    if (target[name] === wrapped) setProp(target, name, base);
  });
  return true;
}

/**
 * Does this factory (as it is right now, through whatever other wrappers sit on top of us)
 * still swap warning dialogs? Asked with a throwaway element, so it has no side effects and
 * works regardless of how many other wrappers are layered around ours.
 */
function isFactoryHooked(target: any, name: string): boolean {
  const probeType = function RemoveDeckyWarningsProbe() {
    return null;
  };
  try {
    const element = target[name](probeType, { type: WARN_TYPE_ZIP, onOK() {}, onCancel() {} });
    return !!element && element.type !== probeType;
  } catch {
    return true; // can't tell; leave it alone rather than risk stacking wrappers
  }
}

function makeShowModalWrapper(base: AnyFn): AnyFn {
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
  return wrapped;
}

/** Wrap DFL.showModal so a warning element is accepted without ever being shown. */
function ensureShowModal(initial: boolean): void {
  const label = 'DFL.showModal';
  const dfl = w.DFL;
  if (!dfl || typeof dfl.showModal !== 'function') {
    setHook(label, false);
    return;
  }
  if (dfl === showModalHook.target && dfl.showModal === showModalHook.wrapped) {
    setHook(label, true);
    return;
  }
  // showModal can't be probed safely (a miss would open a real modal), so a foreign
  // wrapper on top of ours looks like a loss. Cap re-wraps so that can never pile up.
  if (!initial && showModalHook.rewraps >= MAX_SHOWMODAL_REWRAPS) return;

  const current = dfl.showModal;
  const base: AnyFn = current[ORIGINAL] ?? current;
  const wrapped = makeShowModalWrapper(base);
  if (!setProp(dfl, 'showModal', wrapped)) {
    setHook(label, false);
    return;
  }
  if (!initial) {
    showModalHook.rewraps++;
    state.repairs++;
    logEvent(`${label} was overwritten; hooked again`);
  }
  showModalHook.target = dfl;
  showModalHook.wrapped = wrapped;
  setHook(label, true);
  state.restorers.push(() => {
    if (dfl.showModal === wrapped) setProp(dfl, 'showModal', base);
  });
}

/** Install any hook that is missing, and re-install any that stopped working. */
function ensureHooks(initial: boolean): void {
  for (const def of FACTORIES) {
    const target = def.target();
    if (!target || typeof target[def.name] !== 'function') {
      setHook(def.label, false);
      continue;
    }
    if (isFactoryHooked(target, def.name)) {
      setHook(def.label, true);
      continue;
    }
    const wasInstalled = state.hooks.includes(def.label);
    if (wrapFactory(target, def.name)) {
      if (!initial) {
        if (wasInstalled) state.repairs++;
        logEvent(wasInstalled ? `${def.label} was overwritten; hooked again` : `${def.label} appeared; hooked`);
      }
      setHook(def.label, true);
    } else {
      setHook(def.label, false);
    }
  }
  ensureShowModal(initial);
}

/** Mark both warnings as already accepted so the countdown is 0 even without the hooks. */
async function seedAcceptedFlags(initial: boolean): Promise<void> {
  const backend = w.DeckyBackend;
  if (!backend || typeof backend.call !== 'function') return;
  for (const key of ACCEPTED_SETTINGS) {
    try {
      const current = await backend.call('utilities/settings/get', key, false);
      if (current !== true) {
        await backend.call('utilities/settings/set', key, true);
        if (!initial) logEvent(`${key} had been reset; set it again`);
      }
    } catch (e) {
      console.error(TAG, `could not set ${key}`, e);
    }
  }
}

function tick(): void {
  if (!state.active) return;
  try {
    ensureHooks(false);
  } catch (e) {
    console.error(TAG, 'watchdog error', e);
  }
  state.ticks++;
  if (state.ticks % RESEED_EVERY_TICKS === 0) void seedAcceptedFlags(false);
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
  state.events = [];
  state.repairs = 0;
  state.ticks = 0;
  showModalHook.target = null;
  showModalHook.wrapped = null;
  showModalHook.rewraps = 0;

  // Remember the untouched createElement before hooking it (see getReplacement).
  const create = w.SP_REACT?.createElement;
  rawCreateElement = typeof create === 'function' ? create[ORIGINAL] ?? create : null;

  ensureHooks(true);
  w.__removeDeckyWarningsRestore = uninstall;
  state.timer = setInterval(tick, WATCHDOG_MS) as unknown as number;

  if (state.hooks.length === 0) {
    console.warn(TAG, 'could not hook anything yet; the watchdog will keep trying. Countdowns are removed regardless.');
  } else {
    console.log(TAG, `hooked ${state.hooks.join(', ')}`);
  }
  void seedAcceptedFlags(true);
}

function uninstall(): void {
  state.active = false;
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  for (const restore of state.restorers.splice(0)) {
    try {
      restore();
    } catch {
      /* ignore */
    }
  }
  if (w.__removeDeckyWarningsRestore === uninstall) delete w.__removeDeckyWarningsRestore;
  console.log(TAG, 'uninstalled');
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
        React.createElement('br', null),
        `Hook repairs this session: ${state.repairs}`,
      ),
    ),
  ];
  if (state.events.length > 0) {
    rows.push(
      React.createElement(
        PanelSectionRow,
        { key: 'events' },
        React.createElement(
          'div',
          { style: { fontSize: '11px', opacity: 0.7, wordBreak: 'break-all' } },
          'Recent events:',
          ...state.events.flatMap((e) => [React.createElement('br', null), e]),
        ),
      ),
    );
  }
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
export const __internals = { inspect, getReplacement, acceptNow, ensureHooks, tick, state, install, uninstall };
