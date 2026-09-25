// @ts-nocheck
// Shared debug helper — reads PI_SIGNAL_DEBUG env var.

export function createDebug(prefix: string): (...args: unknown[]) => void {
	const PI_SIGNAL_DEBUG = (typeof process !== "undefined"
		? (process.env.PI_SIGNAL_DEBUG || "false")
		: "false"
	).toLowerCase();
	const DEBUG_ENABLED = PI_SIGNAL_DEBUG === "true" || PI_SIGNAL_DEBUG === "1" || PI_SIGNAL_DEBUG === "log";

	return function debug(...args: unknown[]): void {
		if (DEBUG_ENABLED) {
			console.log(`[${prefix}]`, ...args);
		}
	};
}
