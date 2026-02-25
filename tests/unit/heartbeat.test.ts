import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for heartbeat response handling logic.
 *
 * The SDK's postHeartbeat() returns errors as response values (not thrown).
 * Crucially, the SDK's errorHandling() spreads the full response body on HTTP
 * errors, so a 400 "Invalid Heartbeat ID" response comes back as:
 *   { error: "Invalid Heartbeat ID", heartbeat_id: "corrected-uuid", status: 400 }
 *
 * The handler must:
 * 1. Prefer heartbeat_id even when error is also present (corrected ID from server)
 * 2. Only increment failures when there's NO corrected ID in the response
 * 3. Reset to "" (fresh chain) when Invalid ID has no corrected ID
 * 4. Count other API errors (Unauthorized, Server Error) as real failures
 * 5. Handle genuine exceptions (network timeout) as real failures
 */

interface HeartbeatResponse {
  heartbeat_id?: string;
  error?: string;
  status?: number;
}

interface HeartbeatState {
  heartbeatId: string; // "" = fresh start (API expects empty string, not null)
  failures: number;
  shouldPanic: boolean;
  lastMessage: string | null;
}

const MAX_HEARTBEAT_FAILURES = 10;

function handleHeartbeatResponse(
  response: HeartbeatResponse,
  state: HeartbeatState,
  maxFailures: number = MAX_HEARTBEAT_FAILURES,
): HeartbeatState {
  const newState = { ...state, shouldPanic: false, lastMessage: null };

  // Case 1: Response includes a heartbeat_id (success, or error with correction)
  if (response.heartbeat_id) {
    newState.heartbeatId = response.heartbeat_id;
    newState.failures = 0;
    newState.lastMessage = response.error ? "recovered_with_corrected_id" : null;

    if (newState.failures >= maxFailures) {
      newState.shouldPanic = true;
    }
    return newState;
  }

  // Case 2: Error WITHOUT a corrected heartbeat_id
  if (response.error) {
    const errMsg = response.error;
    const isInvalidId = errMsg.includes("Invalid Heartbeat ID") || errMsg.includes("invalid heartbeat");

    if (isInvalidId) {
      // No corrected ID — reset to empty to start fresh chain
      newState.heartbeatId = "";
      newState.failures++;
      newState.lastMessage = "invalid_id_reset";
    } else {
      // Other API error
      newState.failures++;
      newState.lastMessage = errMsg;
    }
  } else {
    // Case 3: Unexpected shape (no error, no heartbeat_id)
    newState.failures++;
    newState.lastMessage = "unexpected_response";
  }

  if (newState.failures >= maxFailures) {
    newState.shouldPanic = true;
  }

  return newState;
}

function handleHeartbeatException(
  err: Error,
  state: HeartbeatState,
  maxFailures: number = MAX_HEARTBEAT_FAILURES,
): HeartbeatState {
  const newState = { ...state, shouldPanic: false };
  newState.failures++;
  newState.lastMessage = err.message;
  if (newState.failures >= maxFailures) {
    newState.shouldPanic = true;
  }
  return newState;
}

describe("heartbeat response handling", () => {
  let state: HeartbeatState;

  beforeEach(() => {
    state = { heartbeatId: "", failures: 0, shouldPanic: false, lastMessage: null };
  });

  it("initial heartbeatId is empty string (not null)", () => {
    expect(state.heartbeatId).toBe("");
  });

  it("stores heartbeat_id on successful response", () => {
    const result = handleHeartbeatResponse(
      { heartbeat_id: "abc-123" },
      state,
    );
    expect(result.heartbeatId).toBe("abc-123");
    expect(result.failures).toBe(0);
    expect(result.shouldPanic).toBe(false);
  });

  it("chains heartbeat_id across multiple successful responses", () => {
    let s = handleHeartbeatResponse({ heartbeat_id: "id-1" }, state);
    expect(s.heartbeatId).toBe("id-1");

    s = handleHeartbeatResponse({ heartbeat_id: "id-2" }, s);
    expect(s.heartbeatId).toBe("id-2");
    expect(s.failures).toBe(0);
  });

  it("uses corrected heartbeat_id from error response (SDK spreads 400 body)", () => {
    state.heartbeatId = "stale-id";
    state.failures = 2;

    // SDK returns { error: "...", heartbeat_id: "corrected", status: 400 }
    const result = handleHeartbeatResponse(
      { error: "Invalid Heartbeat ID", heartbeat_id: "corrected-uuid" },
      state,
    );
    // Should use the corrected ID, NOT reset to ""
    expect(result.heartbeatId).toBe("corrected-uuid");
    expect(result.failures).toBe(0); // Success — resets failures
    expect(result.shouldPanic).toBe(false);
    expect(result.lastMessage).toBe("recovered_with_corrected_id");
  });

  it("resets to empty string when Invalid Heartbeat ID has no corrected ID", () => {
    state.heartbeatId = "stale-id";

    const result = handleHeartbeatResponse(
      { error: "Invalid Heartbeat ID" },
      state,
    );
    expect(result.heartbeatId).toBe("");
    expect(result.failures).toBe(1); // Counts as failure
    expect(result.lastMessage).toBe("invalid_id_reset");
  });

  it("also handles lowercase invalid heartbeat", () => {
    const result = handleHeartbeatResponse(
      { error: "invalid heartbeat id" },
      state,
    );
    expect(result.heartbeatId).toBe("");
    expect(result.failures).toBe(1);
    expect(result.lastMessage).toBe("invalid_id_reset");
  });

  it("counts other API errors as failures", () => {
    const result = handleHeartbeatResponse(
      { error: "Unauthorized" },
      state,
    );
    expect(result.failures).toBe(1);
    expect(result.lastMessage).toBe("Unauthorized");
    expect(result.shouldPanic).toBe(false);
  });

  it("handles unexpected response shape", () => {
    const result = handleHeartbeatResponse(
      {} as HeartbeatResponse,
      state,
    );
    expect(result.failures).toBe(1);
    expect(result.lastMessage).toBe("unexpected_response");
  });

  it("triggers panic after max failures", () => {
    state.failures = MAX_HEARTBEAT_FAILURES - 1;
    const result = handleHeartbeatResponse(
      { error: "Server Error" },
      state,
    );
    expect(result.failures).toBe(MAX_HEARTBEAT_FAILURES);
    expect(result.shouldPanic).toBe(true);
  });

  it("resets failure count on success after errors", () => {
    state.failures = 8;
    const result = handleHeartbeatResponse(
      { heartbeat_id: "recovered" },
      state,
    );
    expect(result.failures).toBe(0);
    expect(result.shouldPanic).toBe(false);
    expect(result.heartbeatId).toBe("recovered");
  });

  it("handles genuine exceptions (network timeout)", () => {
    const result = handleHeartbeatException(
      new Error("ETIMEDOUT"),
      state,
    );
    expect(result.failures).toBe(1);
    expect(result.lastMessage).toBe("ETIMEDOUT");
  });

  it("panics after max exception failures", () => {
    state.failures = MAX_HEARTBEAT_FAILURES - 1;
    const result = handleHeartbeatException(
      new Error("ECONNRESET"),
      state,
    );
    expect(result.failures).toBe(MAX_HEARTBEAT_FAILURES);
    expect(result.shouldPanic).toBe(true);
  });

  it("corrected ID in error response prevents failure escalation", () => {
    // Simulate repeated "Invalid Heartbeat ID" WITH corrected IDs
    // This should never escalate failures — the server is helping us recover
    let s = state;
    for (let i = 0; i < 20; i++) {
      s = handleHeartbeatResponse(
        { error: "Invalid Heartbeat ID", heartbeat_id: `corrected-${i}` },
        s,
      );
    }
    expect(s.failures).toBe(0);
    expect(s.shouldPanic).toBe(false);
    expect(s.heartbeatId).toBe("corrected-19");
  });

  it("panics when repeated Invalid ID errors have no corrected ID", () => {
    let s = state;
    for (let i = 0; i < MAX_HEARTBEAT_FAILURES; i++) {
      s = handleHeartbeatResponse(
        { error: "Invalid Heartbeat ID" },
        s,
      );
    }
    expect(s.failures).toBe(MAX_HEARTBEAT_FAILURES);
    expect(s.shouldPanic).toBe(true);
    expect(s.heartbeatId).toBe("");
  });

  it("recovers from failures when corrected ID finally arrives", () => {
    state.failures = 5;
    state.heartbeatId = "";

    const result = handleHeartbeatResponse(
      { error: "Invalid Heartbeat ID", heartbeat_id: "new-chain" },
      state,
    );
    expect(result.failures).toBe(0);
    expect(result.heartbeatId).toBe("new-chain");
    expect(result.shouldPanic).toBe(false);
  });
});
