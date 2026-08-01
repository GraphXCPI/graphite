<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import Editor from "/src/components/Editor.svelte";
	import { createSubscriptionsRouter } from "/src/subscriptions-router";
	import type { MessageName, SubscriptionsRouter } from "/src/subscriptions-router";
	import { loadDemoArtwork } from "/src/utility-functions/network";
	import { operatingSystem } from "/src/utility-functions/platform";
	import { postFatalError } from "/src/utility-functions/tool-bridge";
	import init, { EditorWrapper, receiveNativeMessage } from "/wrapper/pkg/graphite_wasm_wrapper";
	import type { FrontendMessage } from "/wrapper/pkg/graphite_wasm_wrapper";

	let subscriptions: SubscriptionsRouter | undefined = undefined;
	let editor: EditorWrapper | undefined = undefined;
	// GraphX Studio fork (Track D, D1b, review round 1 / B7): tracks a wasm-init failure so
	// this component can show a minimal inline fallback for standalone (non-bridged) use, in
	// addition to (not instead of) telling a bridged host via postFatalError below -- Studio's
	// GraphiteEmbed shows its own retriable error on that message, but this page can also be
	// opened directly (dev, or a parent that never sends `init`), where nothing else would.
	let wasmInitFailed = false;

	onMount(async () => {
		try {
			// Initialize the editor wrapper
			const wrapper = await init();
			for (const [name, f] of Object.entries(wrapper)) {
				if (name.startsWith("__node_registry")) f();
			}
			window.imageCanvases = {};
			window.receiveNativeMessage = receiveNativeMessage;

			// Create the editor and subscriptions router
			const randomSeed = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
			subscriptions = createSubscriptionsRouter();
			editor = await EditorWrapper.create(operatingSystem(), randomSeed, (messageType: MessageName, messageData: FrontendMessage) => {
				subscriptions?.handleFrontendMessage(messageType, messageData);
			});

			await loadDemoArtwork(editor);
		} catch (err) {
			// A corrupt/truncated wasm binary, a fetch failure, or any other init-time error
			// previously surfaced as nothing at all: no crash (isolated in the iframe either
			// way), but no error either -- just a permanently blank pane. Tell a bridged host
			// (D1b AC3's degradation path) and show a minimal inline fallback either way.
			wasmInitFailed = true;
			postFatalError(err instanceof Error ? err.message : String(err));
			// eslint-disable-next-line no-console
			console.error("Graphite failed to initialize:", err);
		}
	});

	onDestroy(() => {
		editor?.free();
	});
</script>

{#if wasmInitFailed}
	<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font:13px sans-serif;color:#ccc;background:#222;">
		The vector editor failed to load. Please try reloading.
	</div>
{:else if subscriptions !== undefined && editor !== undefined}
	<Editor {subscriptions} {editor} />
{/if}
