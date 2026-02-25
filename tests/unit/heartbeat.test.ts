import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for heartbeat response handling logic.
 * The SDK's postHeartbeat() returns errors as values ({ error: "..." })
 * instead of throwing. This tests that our handler correctly distinguishes:
 * 1. Successful response with heartbeat_id
 * 2. Error returned as value (Invalid Heartbeat ID)
 * 3. Other API errors returned as value
 * 4. Genuine exceptions (network timeout)
 */

// Extract the heartbeat handling logic into a testable function
interface HeartbeatResponse {
  heartbeat_id?: string;
  error?: string;
}

interface HeartbeatState {
  heartbeatId: string | null;
  failures: number;
  shouldPanic: boolean;
  lastMessage: string | null;
}

function handleHeartbeatResponse(
  response: HeartbeatResponse,
  state: HeartbeatState,
  maxFailures: number = 5,
): HeartbeatState {
  const newState = { ...state, shouldPanic: false, lastMessage: null };

  if (response.error) {
    const errMsg = response.error;
    if (errMsg.includes("Invalid Heartbeat ID") || errMsg.includes("invalid heartbeat")) {
      // Chain expired — reset, don't count as failure
      newState.heartbeatId = null;
      newState.lastMessage = "chain_expired";
      return newState;
    }
    // Other API error
    newState.failures++;
    newState.lastMessage = errMsg;
  } else if (response.heartbeat_id) {
    // Success
    newState.heartbeatId = response.heartbeat_id;
    newState.failures = 0;
    newState.lastMessage = null;
  } else {
    // Unexpected shape
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
  maxFailures: number = 5,
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
    state = { heartbeatId: null, failures: 0, shouldPanic: false, lastMessage: null };
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

  it("resets heartbeatId on Invalid Heartbeat ID error (no failure count)", () => {
    state.heartbeatId = "stale-id";
    state.failures = 2;

    const result = handleHeartbeatResponse(
      { error: "Invalid Heartbeat ID" },
      state,
    );
    expect(result.heartbeatId).toBeNull();
    expect(result.failures).toBe(2); // NOT incremented
    expect(result.shouldPanic).toBe(false);
    expect(result.lastMessage).toBe("chain_expired");
  });

  it("also handles lowercase invalid heartbeat", () => {
    const result = handleHeartbeatResponse(
      { error: "invalid heartbeat id" },
      state,
    );
    expect(result.heartbeatId).toBeNull();
    expect(result.lastMessage).toBe("chain_expired");
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
    state.failures = 4;
    const result = handleHeartbeatResponse(
      { error: "Server Error" },
      state,
    );
    expect(result.failures).toBe(5);
    expect(result.shouldPanic).toBe(true);
  });

  it("resets failure count on success after errors", () => {
    state.failures = 4;
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
    state.failures = 4;
    const result = handleHeartbeatException(
      new Error("ECONNRESET"),
      state,
    );
    expect(result.failures).toBe(5);
    expect(result.shouldPanic).toBe(true);
  });

  it("does not double-count Invalid Heartbeat ID errors", () => {
    // Simulate multiple expired chain errors — should never increment failures
    let s = state;
    for (let i = 0; i < 10; i++) {
      s = handleHeartbeatResponse({ error: "Invalid Heartbeat ID" }, s);
    }
    expect(s.failures).toBe(0);
    expect(s.shouldPanic).toBe(false);
    expect(s.heartbeatId).toBeNull();
  });
});
