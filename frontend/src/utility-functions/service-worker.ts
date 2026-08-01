export async function registerServiceWorker() {
	try {
		// GraphX Studio fork (Track D, D1b): both the registered script path and the
		// scope must move with the build's `base` (vite.config.ts's `GRAPHITE_BASE_PATH`,
		// e.g. "/tools/graphite/" instead of "/") -- a hardcoded "/" would ask the browser
		// to register a service worker scoped to the WHOLE origin, which the browser
		// refuses (a SW's scope can never exceed its own script's directory) once this
		// bundle is served from a subpath. `import.meta.env.BASE_URL` is Vite's own
		// runtime reflection of `base`, always trailing-slash-terminated.
		const base = import.meta.env.BASE_URL;
		const registration = await navigator.serviceWorker.register(`${base}service-worker.js`, { scope: base });

		// GraphX Studio fork (Track D, D1b): this used to register an `updatefound` listener
		// that called `window.location.reload()` once a new service worker activated over an
		// existing controller. That's removed entirely, not just gated: a page hosted inside
		// Studio's shell (iframe today, module-mount at D1c) must never unilaterally reload
		// itself -- doing so can silently drop whatever the surrounding Studio chrome or an
		// agent was doing mid-action (see `d1a-evidence.md` §4's note on this same code). Our
		// deployment serves one pinned build per pin advance (never a live-updating tag under
		// an open tab), so there is no live-update case this app needs to auto-recover from; a
		// manual page reload covers pin advances. The new service worker still activates and
		// takes over caching on its own (`skipWaiting()`/`clients.claim()` in
		// `service-worker.js` are unchanged) -- we simply no longer force-navigate the host
		// page out from under Studio when that happens.

		const activeWorker = registration.active || registration.waiting || registration.installing;
		if (!activeWorker) return;

		const scheduleDeferredCaching = () => {
			if (activeWorker.state !== "activated") return;
			const sendMessage = () => registration.active?.postMessage({ type: "CACHE_DEFERRED" });
			if ("requestIdleCallback" in window) window.requestIdleCallback(sendMessage);
			else setTimeout(sendMessage, 5000); // Fallback to a delay for Safari which doesn't support `requestIdleCallback`
		};

		// Once the service worker is active, trigger deferred caching during idle time
		if (activeWorker.state === "activated") scheduleDeferredCaching();
		else activeWorker.addEventListener("statechange", scheduleDeferredCaching);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.error("Service worker registration failed:", err);
	}
}
