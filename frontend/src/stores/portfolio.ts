import { tick } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { writable } from "svelte/store";
import type { Writable } from "svelte/store";
import type { SubscriptionsRouter } from "/src/subscriptions-router";
import { downloadFile, downloadFileBlob, upload } from "/src/utility-functions/files";
import { rasterizeSVG } from "/src/utility-functions/rasterization";
import { initToolBridge, isToolBridgeActive, onToolBridgeMessage, postDocumentDirty, postExportRequest, postSaveRequest, toolBridgeDocumentId } from "/src/utility-functions/tool-bridge";
import { patchLayout } from "/src/utility-functions/widgets";
import type { EditorWrapper, DocumentInfo, LayerPanelEntry, LayerStructureEntry, Layout, WorkspacePanelLayout } from "/wrapper/pkg/graphite_wasm_wrapper";

export type PortfolioStore = ReturnType<typeof createPortfolioStore>;

type PortfolioStoreState = {
	unsaved: boolean;
	documents: DocumentInfo[];
	activeDocumentIndex: number;
	panelLayout: WorkspacePanelLayout;
	layerCache: SvelteMap<string, LayerPanelEntry>;
	layerStructure: LayerStructureEntry[];
};
const initialState: PortfolioStoreState = {
	unsaved: false,
	documents: [],
	activeDocumentIndex: 0,
	panelLayout: {},
	layerCache: new SvelteMap<string, LayerPanelEntry>(),
	layerStructure: [],
};

let subscriptionsRouter: SubscriptionsRouter | undefined = undefined;

// GraphX Studio fork (Track D, D1b): unsubscribe handle for the Tool Bridge's inbound message
// listener, torn down alongside the rest of this store's subscriptions.
let unsubscribeToolBridge: (() => void) | undefined = undefined;

// Store state persisted across HMR to maintain reactive subscriptions in the component tree
const store: Writable<PortfolioStoreState> = import.meta.hot?.data?.store || writable<PortfolioStoreState>(initialState);
if (import.meta.hot) import.meta.hot.data.store = store;
const { subscribe, update } = store;

export const welcomeScreenButtonsLayout = makeLayoutStore("welcomeScreenButtonsLayout");
export const propertiesPanelLayout = makeLayoutStore("propertiesPanelLayout");
export const dataPanelLayout = makeLayoutStore("dataPanelLayout");
export const layersPanelControlBarLeftLayout = makeLayoutStore("layersPanelControlBarLeftLayout");
export const layersPanelControlBarRightLayout = makeLayoutStore("layersPanelControlBarRightLayout");
export const layersPanelBottomBarLayout = makeLayoutStore("layersPanelBottomBarLayout");

// Each panel layout has its own dedicated store so a layout update only re-renders that panel's consumers.
// Putting them at module scope (not inside the component) lets them survive a Svelte remount during a
// panel-tree restructure, since the backend's diff-based updates aren't re-sent on subscribe.
function makeLayoutStore(name: string): Writable<Layout> {
	const persisted = import.meta.hot?.data?.[name];
	const layoutStore: Writable<Layout> = persisted || writable<Layout>([]);
	if (import.meta.hot) import.meta.hot.data[name] = layoutStore;
	return layoutStore;
}

function patchLayoutStore(layoutStore: Writable<Layout>, data: Parameters<typeof patchLayout>[1]) {
	layoutStore.update((layout) => {
		patchLayout(layout, data);
		return layout;
	});
}

export function createPortfolioStore(subscriptions: SubscriptionsRouter, editor: EditorWrapper) {
	destroyPortfolioStore();

	subscriptionsRouter = subscriptions;

	// GraphX Studio fork (Track D, D1b): try the Tool Bridge handshake; every handler below
	// checks `isToolBridgeActive()` at call time rather than awaiting this, since by the time a
	// user (or the host) triggers any of these messages, the short init window has resolved.
	void initToolBridge();

	unsubscribeToolBridge = onToolBridgeMessage((message) => {
		if (message.type === "loadDocument") {
			if (message.pendingImportSvg) {
				// TECH-D §4.3 "generate": the bridge stored an agent-submitted SVG as a pending
				// import against a new tool-doc; create the empty document and paste the SVG into
				// it as the document's initial content.
				editor.newDocumentWithName(message.name || undefined);
				editor.pasteSvg(message.name || undefined, message.pendingImportSvg, undefined, undefined, undefined, undefined);
			} else if (message.content) {
				editor.openFile(message.name, new Uint8Array(message.content));
			}
			return;
		}

		if (message.type === "saveResult") {
			// GraphX Studio fork (Track D, D1b, review round 1 / B5): a bridge save can
			// genuinely fail (409 stale revision, 413 over a storage ceiling) -- unlike a
			// native file-system save or browser download, which this editor otherwise
			// assumes always succeeds. Only mark the document saved on CONFIRMED success;
			// surface a failure to the user instead of silently discarding it.
			if (message.ok) {
				editor.markActiveDocumentSaved();
			} else {
				editor.errorDialog("Save failed", message.error || "The document could not be saved. Your changes are still open here -- try saving again.");
			}
		}
	});

	subscriptions.subscribeFrontendMessage("UpdateOpenDocumentsList", (data) => {
		update((state) => {
			state.documents = data.openDocuments;
			if (state.documents.length === 0) state.activeDocumentIndex = 0;
			return state;
		});

		// GraphX Studio fork (Track D, D1b): forward dirty state to a bridged host so it can
		// show a dirty-state indicator (TECH-D §7's "Frontend" deliverable). A bridged embed
		// manages exactly one tool-doc per session, so "any open document unsaved" is the
		// dirty signal for that one tool-doc.
		if (isToolBridgeActive()) {
			const docId = toolBridgeDocumentId();
			if (docId)
				postDocumentDirty(
					docId,
					data.openDocuments.some((doc) => !doc.is_saved),
				);
		}
	});

	subscriptions.subscribeFrontendMessage("UpdateActiveDocument", (data) => {
		update((state) => {
			// Assume we receive a correct document id
			const activeId = state.documents.findIndex((doc) => doc.id === data.documentId);
			state.activeDocumentIndex = activeId;
			return state;
		});
	});

	subscriptions.subscribeFrontendMessage("TriggerFetchAndOpenDocument", async (data) => {
		try {
			const url = new URL(`demo-artwork/${data.filename}`, document.location.href);
			const response = await fetch(url);
			editor.openFile(data.filename, await response.bytes());
		} catch {
			// Needs to be delayed until the end of the current call stack so the existing demo artwork dialog can be closed first, otherwise this dialog won't show
			setTimeout(() => {
				editor.errorDialog("Failed to open document", "The file could not be reached over the internet. You may be offline, or it may be missing.");
			}, 0);
		}
	});

	subscriptions.subscribeFrontendMessage("TriggerOpen", async () => {
		if (isToolBridgeActive()) {
			// GraphX Studio fork (Track D, D1b): a bridged embed manages exactly one tool-doc
			// per session (TECH-D §4.1); the bridge's message schema has no "pick a different
			// tool-doc" request, and Studio has no such picker UI yet (job assets inside tools
			// is D2 scope). Recorded gap, not a silent native fallback: deliberately a no-op
			// rather than opening the browser's native file picker, which would break the
			// "one app" framing this patch exists to satisfy.
			return;
		}
		const files = await upload(`image/*,.${editor.fileExtension()}`, "data", true);
		files.forEach((file) => editor.openFile(file.filename, file.content));
	});

	subscriptions.subscribeFrontendMessage("TriggerImport", async () => {
		// TODO: Use the same `accept` string as in the `TriggerOpen` handler once importing Graphite documents as nodes is supported
		const data = await upload("image/*", "data");
		editor.importFile(data.filename, data.content);
	});

	subscriptions.subscribeFrontendMessage("TriggerSaveDocument", (data) => {
		if (isToolBridgeActive()) {
			const docId = toolBridgeDocumentId();
			if (docId) postSaveRequest(docId, data.name, data.content);
			return;
		}
		downloadFile(data.name, data.content);
	});

	subscriptions.subscribeFrontendMessage("TriggerSaveFile", (data) => {
		if (isToolBridgeActive()) {
			const docId = toolBridgeDocumentId();
			if (docId) postSaveRequest(docId, data.name, data.content);
			return;
		}
		downloadFile(data.name, data.content);
	});

	subscriptions.subscribeFrontendMessage("TriggerExportImage", async (data) => {
		const { svg, name, mime, size } = data;

		if (isToolBridgeActive()) {
			const docId = toolBridgeDocumentId();
			if (docId) postExportRequest(docId, name, mime, size, svg);
			return;
		}

		// Fill the canvas with white if it'll be a JPEG (which does not support transparency and defaults to black)
		const backgroundColor = mime.endsWith("jpeg") ? "white" : undefined;

		// Rasterize the SVG to an image file
		try {
			const blob = await rasterizeSVG(svg, size[0], size[1], mime, backgroundColor);

			// Have the browser download the file to the user's disk
			downloadFileBlob(name, blob);
		} catch {
			// Fail silently if there's an error rasterizing the SVG, such as a zero-sized image
		}
	});

	subscriptions.subscribeFrontendMessage("UpdateWorkspacePanelLayout", (data) => {
		update((state) => {
			state.panelLayout = data.panelLayout;
			return state;
		});
	});

	// Each panel layout uses its own store so updates only re-render that panel's consumers
	subscriptions.subscribeLayoutUpdate("WelcomeScreenButtons", async (data) => {
		await tick();
		patchLayoutStore(welcomeScreenButtonsLayout, data);
	});

	subscriptions.subscribeLayoutUpdate("PropertiesPanel", async (data) => {
		await tick();
		patchLayoutStore(propertiesPanelLayout, data);
	});

	subscriptions.subscribeLayoutUpdate("DataPanel", async (data) => {
		await tick();
		patchLayoutStore(dataPanelLayout, data);
	});

	subscriptions.subscribeLayoutUpdate("LayersPanelControlLeftBar", async (data) => {
		await tick();
		patchLayoutStore(layersPanelControlBarLeftLayout, data);
	});

	subscriptions.subscribeLayoutUpdate("LayersPanelControlRightBar", async (data) => {
		await tick();
		patchLayoutStore(layersPanelControlBarRightLayout, data);
	});

	subscriptions.subscribeLayoutUpdate("LayersPanelBottomBar", async (data) => {
		await tick();
		patchLayoutStore(layersPanelBottomBarLayout, data);
	});

	subscriptions.subscribeFrontendMessage("UpdateDocumentLayerStructure", (data) => {
		update((state) => {
			state.layerStructure = data.layerStructure;
			return state;
		});
	});

	subscriptions.subscribeFrontendMessage("UpdateDocumentLayerDetails", (data) => {
		update((state) => {
			state.layerCache.set(String(data.data.id), data.data);
			return state;
		});
	});

	return { subscribe };
}

export function destroyPortfolioStore() {
	const subscriptions = subscriptionsRouter;
	if (!subscriptions) return;

	unsubscribeToolBridge?.();
	unsubscribeToolBridge = undefined;

	subscriptions.unsubscribeFrontendMessage("UpdateOpenDocumentsList");
	subscriptions.unsubscribeFrontendMessage("UpdateActiveDocument");
	subscriptions.unsubscribeFrontendMessage("TriggerFetchAndOpenDocument");
	subscriptions.unsubscribeFrontendMessage("TriggerOpen");
	subscriptions.unsubscribeFrontendMessage("TriggerImport");
	subscriptions.unsubscribeFrontendMessage("TriggerSaveDocument");
	subscriptions.unsubscribeFrontendMessage("TriggerSaveFile");
	subscriptions.unsubscribeFrontendMessage("TriggerExportImage");
	subscriptions.unsubscribeFrontendMessage("UpdateWorkspacePanelLayout");
	subscriptions.unsubscribeLayoutUpdate("WelcomeScreenButtons");
	subscriptions.unsubscribeLayoutUpdate("PropertiesPanel");
	subscriptions.unsubscribeLayoutUpdate("DataPanel");
	subscriptions.unsubscribeLayoutUpdate("LayersPanelControlLeftBar");
	subscriptions.unsubscribeLayoutUpdate("LayersPanelControlRightBar");
	subscriptions.unsubscribeLayoutUpdate("LayersPanelBottomBar");
	subscriptions.unsubscribeFrontendMessage("UpdateDocumentLayerStructure");
	subscriptions.unsubscribeFrontendMessage("UpdateDocumentLayerDetails");
}
