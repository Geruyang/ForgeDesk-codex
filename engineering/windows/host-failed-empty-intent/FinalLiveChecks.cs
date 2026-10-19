using System;

// Contains no field initializers, token lookups, filesystem or native calls.
internal static class FailedEmptyIntentFinalLiveChecks {
    internal static void Assert(Action sourceAbsent, Action companionsAbsent, Action homeEmpty, Func<bool> stableIdentities) {
        sourceAbsent(); companionsAbsent(); homeEmpty();
        if (!stableIdentities()) throw new InvalidOperationException("FZ3B_FAILED_EMPTY_INTENT_FINAL_LIVE_POSTCHECK");
    }
}
