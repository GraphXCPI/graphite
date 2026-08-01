import { tick } from "svelte";
import { writable } from "svelte/store";
import type { Writable } from "svelte/store";
import type { IconName } from "/src/icons";
import type { SubscriptionsRouter } from "/src/subscriptions-router";
import { patchLayout } from "/src/utility-functions/widgets";
import type { EditorWrapper, Layout } from "/wrapper/pkg/graphite_wasm_wrapper";

export type DialogStore = ReturnType<typeof createDialogStore>;

type DialogStoreState = {
	visible: boolean;
	title: string;
	icon: IconName | undefined;
	buttons: Layout;
	column1: Layout;
	column2: Layout;
	panicDetails: string;
};
const initialState: DialogStoreState = {
	visible: false,
	title: "",
	icon: undefined,
	buttons: [],
	column1: [],
	column2: [],
	// Special case for the crash dialog because we cannot handle button widget callbacks from Rust once the editor has panicked
	panicDetails: "",
};

let subscriptionsRouter: SubscriptionsRouter | undefined = undefined;

// Store state persisted across HMR to maintain reactive subscriptions in the component tree
const store: Writable<DialogStoreState> = import.meta.hot?.data?.store || writable<DialogStoreState>(initialState);
if (import.meta.hot) import.meta.hot.data.store = store;
const { subscribe, update } = store;

export function createDialogStore(subscriptions: SubscriptionsRouter, editor: EditorWrapper) {
	destroyDialogStore();

	subscriptionsRouter = subscriptions;

	subscriptions.subscribeFrontendMessage("DisplayDialog", (data) => {
		update((state) => {
			state.visible = true;

			state.title = data.title;
			state.icon = data.icon;

			return state;
		});
	});

	subscriptions.subscribeLayoutUpdate("DialogButtons", async (data) => {
		await tick();

		update((state) => {
			patchLayout(state.buttons, data);

			return state;
		});
	});

	subscriptions.subscribeLayoutUpdate("DialogColumn1", async (data) => {
		await tick();

		update((state) => {
			patchLayout(state.column1, data);

			return state;
		});
	});

	subscriptions.subscribeLayoutUpdate("DialogColumn2", async (data) => {
		await tick();

		update((state) => {
			patchLayout(state.column2, data);

			return state;
		});
	});

	subscriptions.subscribeFrontendMessage("DialogClose", () => {
		update((state) => {
			// Disallow dismissing the crash dialog since it should remain as the final notification
			if (state.panicDetails === "") state.visible = false;

			return state;
		});
	});

	subscriptions.subscribeFrontendMessage("TriggerDisplayThirdPartyLicensesDialog", async () => {
		// GraphX Studio fork (Track D, D1b): both the fetch path (base-path-aware, same
		// reason as the service-worker registration patch above) and the backup message
		// updated -- the upstream backup URL points at editor.graphite.art, which is not
		// only a dead reference for a self-hosted fork but exactly the kind of external
		// URL this increment's zero-network patches exist to avoid suggesting.
		const base = import.meta.env.BASE_URL;
		let licenseText = "Content was not able to load. Please check your network connection and try again.";

		try {
			const response = await fetch(`${base}third-party-licenses.txt`);
			if (response.ok && response.headers.get("Content-Type")?.includes("text/plain")) licenseText = await response.text();
		} catch {
			// Do nothing on network error
		}

		editor.requestLicensesThirdPartyDialogWithLicenseText(licenseText);
	});

	return { subscribe };
}

export function destroyDialogStore() {
	const subscriptions = subscriptionsRouter;
	if (!subscriptions) return;

	subscriptions.unsubscribeFrontendMessage("DisplayDialog");
	subscriptions.unsubscribeFrontendMessage("DialogClose");
	subscriptions.unsubscribeFrontendMessage("TriggerDisplayThirdPartyLicensesDialog");
	subscriptions.unsubscribeLayoutUpdate("DialogButtons");
	subscriptions.unsubscribeLayoutUpdate("DialogColumn1");
	subscriptions.unsubscribeLayoutUpdate("DialogColumn2");
}

// Creates a crash dialog from JS once the editor has panicked.
// Normal dialogs are created in the Rust backend, but for the crash dialog, the editor has panicked so it cannot respond to widget callbacks.
export function createCrashDialog(panicDetails: string) {
	update((state) => {
		state.visible = true;

		state.icon = "Failure";
		state.title = "Crash";
		state.panicDetails = panicDetails;

		state.column1 = [];
		state.column2 = [];
		state.buttons = [];

		return state;
	});
}
