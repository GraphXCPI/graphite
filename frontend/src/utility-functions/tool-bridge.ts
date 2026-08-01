// GraphX Studio fork (Track D, D1b): the postMessage side of the Tool Bridge adapter
// (TECH-D-design-engine.md §4.2). This module speaks a small versioned message schema to a
// parent frame (Studio's host page, see `web/src/lib/toolBridge.ts` in the studio repo -- a
// separate repo, so nothing here imports from it; the two sides are kept in sync by the
// shared contract doc, not by shared code). It replaces the browser-native file-picker/
// download behavior in `frontend/src/stores/portfolio.ts`'s four handlers
// (TriggerOpen/TriggerSaveDocument/TriggerSaveFile/TriggerExportImage) when a parent bridge is
// present, and falls back to that native behavior otherwise -- so the fork keeps working
// standalone for local dev with no parent frame at all.
//
// Handshake: on load, this module listens for an `init` message from `window.parent`. If one
// arrives within `INIT_TIMEOUT_MS`, the bridge is considered active for the rest of the
// session and all four handlers forward to the parent instead of using native browser APIs.
// If no `init` arrives in time (no parent, or a parent that doesn't speak this protocol), the
// bridge is marked inactive and every caller falls back to native behavior permanently.

export type ToolBridgeInboundMessage =
	| { v: 1; type: "init"; tool: "graphite"; docId?: string }
	| { v: 1; type: "loadDocument"; docId: string; name: string; content?: number[]; pendingImportSvg?: string }
	| { v: 1; type: "saveResult"; docId: string; ok: boolean; revision?: number; error?: string }
	| { v: 1; type: "exportResult"; docId: string; ok: boolean; assetId?: string; error?: string };

export type ToolBridgeOutboundMessage =
	| { v: 1; type: "documentDirty"; docId: string; dirty: boolean }
	| { v: 1; type: "saveRequest"; docId: string; name: string; content: number[] }
	| { v: 1; type: "exportRequest"; docId: string; name: string; mime: string; size: [number, number]; svg: string }
	| { v: 1; type: "fatalError"; message: string };

const INIT_TIMEOUT_MS = 1500;

type BridgeState = "pending" | "active" | "inactive";

let state: BridgeState = "pending";
let parentOrigin = "";
// GraphX Studio fork (Track D, D1b, review round 1 / MIN11): the actual window object that
// sent `init`, locked alongside `parentOrigin`. Origin alone identifies WHICH site a message
// claims to be from; `source` identifies WHICH window/frame object actually sent it -- with
// `allow-scripts allow-same-origin` on the iframe (TECH-D §3.2), same-origin script elsewhere
// on the page (or a nested frame) could otherwise spoof messages that merely match the origin.
let parentSource: MessageEventSource | undefined;
let activeDocId: string | undefined;
const inboundHandlers = new Set<(message: ToolBridgeInboundMessage) => void>();

function isToolBridgeMessage(data: unknown): data is ToolBridgeInboundMessage {
	if (typeof data !== "object" || data === null) return false;
	if (!("v" in data) || !("type" in data)) return false;
	return data.v === 1;
}

function handleWindowMessage(event: MessageEvent) {
	const data: unknown = event.data;
	if (!isToolBridgeMessage(data)) return;

	if (state === "pending" && data.type === "init") {
		// Only `window.parent` itself may announce the bridge -- not an arbitrary same-origin
		// window/frame that happens to guess the message shape.
		if (event.source !== window.parent) return;
		state = "active";
		parentOrigin = event.origin;
		parentSource = event.source ?? undefined;
		activeDocId = data.docId;
		// GraphX Studio fork (Track D, D1b, review round 1): acknowledge immediately. The
		// host may have sent `init` (and a `loadDocument` right behind it) BEFORE this
		// listener was even registered -- wasm init (App.svelte's onMount, which is what
		// eventually calls createPortfolioStore -> initToolBridge) is async and can take
		// noticeably longer than the iframe's DOM `load` event the host fires on, so a
		// single fire-and-forget `init` from the host is a real, reproducible race (caught
		// by a real AppShell-driven Playwright run, never by a bare-server smoke test that
		// skips the handshake entirely). This ack tells a HOST THAT RETRIES `init` (see
		// web/src/lib/toolBridge.ts's ToolBridgeHost) that it's now safe to send
		// `loadDocument` exactly once, instead of guessing a fixed delay.
		if (data.docId) post({ v: 1, type: "documentDirty", docId: data.docId, dirty: false });
	}

	// Once active, only accept further messages from the exact origin AND window/frame object
	// that sent `init` -- either check alone is spoofable by a different same-origin context.
	if (state === "active" && (event.origin !== parentOrigin || event.source !== parentSource)) return;

	inboundHandlers.forEach((handler) => handler(data));
}

/**
 * Waits briefly for a parent frame to announce itself via an `init` message. Resolves `true`
 * if the Tool Bridge is active (a parent responded in time) or `false` if this editor should
 * fall back to native standalone behavior (no parent, or the wait timed out).
 */
export function initToolBridge(): Promise<boolean> {
	if (typeof window === "undefined" || window.parent === window) {
		state = "inactive";
		return Promise.resolve(false);
	}

	window.addEventListener("message", handleWindowMessage);

	return new Promise((resolve) => {
		const check = () => {
			if (state !== "pending") {
				resolve(state === "active");
				return;
			}
			setTimeout(check, 50);
		};
		setTimeout(() => {
			if (state === "pending") state = "inactive";
			resolve(state === "active");
		}, INIT_TIMEOUT_MS);
		check();
	});
}

export function isToolBridgeActive(): boolean {
	return state === "active";
}

export function toolBridgeDocumentId(): string | undefined {
	return activeDocId;
}

export function onToolBridgeMessage(handler: (message: ToolBridgeInboundMessage) => void): () => void {
	inboundHandlers.add(handler);
	return () => inboundHandlers.delete(handler);
}

function post(message: ToolBridgeOutboundMessage) {
	if (state !== "active" || !parentOrigin) return;
	window.parent.postMessage(message, parentOrigin);
}

export function postDocumentDirty(docId: string, dirty: boolean) {
	post({ v: 1, type: "documentDirty", docId, dirty });
}

export function postSaveRequest(docId: string, name: string, content: Uint8Array) {
	post({ v: 1, type: "saveRequest", docId, name, content: Array.from(content) });
}

export function postExportRequest(docId: string, name: string, mime: string, size: [number, number], svg: string) {
	post({ v: 1, type: "exportRequest", docId, name, mime, size, svg });
}

export function postFatalError(message: string) {
	// GraphX Studio fork (Track D, D1b, review round 2 / BLOCKER 5): every OTHER
	// outbound message goes through `post()`, which is a no-op until the bridge is
	// ACTIVE (a full `init` handshake has completed) -- correct for messages that
	// carry real document data, wrong for this one. A wasm-init failure (a corrupt
	// or truncated binary, a fetch failure, anything `App.svelte`'s `onMount` catches)
	// happens BEFORE `initToolBridge()` is even called: that only happens from inside
	// `createPortfolioStore`, which itself only runs once `EditorWrapper.create()`
	// has already SUCCEEDED. So the exact failure this message exists to report is
	// also the one case where the normal activation handshake can never complete --
	// `post()`'s gate silently swallowed every `fatalError` a real wasm failure
	// would ever produce (confirmed: no `postFatalError` call anywhere in this
	// module's own history ever had a caller that could reach it post-activation).
	//
	// Sent unconditionally, straight to `window.parent`, at `window.location.origin`
	// rather than the (not-yet-known, because `init` never arrived) `parentOrigin` --
	// safe because this embed is ONLY ever served same-origin-framed (the backend's
	// CSP is `frame-ancestors 'self'`, review round 1 / M9), so the parent's origin
	// and this frame's own origin are always identical by construction. This is a
	// one-shot emergency broadcast for this ONE message type; every other outbound
	// message still requires full activation before it's ever sent.
	if (typeof window !== "undefined" && window.parent !== window) {
		try {
			window.parent.postMessage({ v: 1, type: "fatalError", message }, window.location.origin);
		} catch {
			// no parent listening (standalone dev, or a parent that rejects postMessage) --
			// nothing more to do here.
		}
	}
	post({ v: 1, type: "fatalError", message });
}
