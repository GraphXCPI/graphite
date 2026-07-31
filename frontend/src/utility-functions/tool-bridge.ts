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
		state = "active";
		parentOrigin = event.origin;
		activeDocId = data.docId;
	}

	// Once active, only accept further messages from the same origin that sent `init`
	if (state === "active" && event.origin !== parentOrigin) return;

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
	post({ v: 1, type: "fatalError", message });
}
