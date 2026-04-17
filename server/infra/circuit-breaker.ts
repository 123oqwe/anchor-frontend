/**
 * L8 Infrastructure — Circuit Breaker.
 *
 * Prevents cascading failures from external services.
 * States: CLOSED (normal) → OPEN (blocking) → HALF_OPEN (testing)
 *
 * After N consecutive failures, circuit opens and rejects all calls
 * for a cooldown period. After cooldown, allows one test call.
 * If test succeeds → close. If test fails → open again.
 */

type CircuitState = "closed" | "open" | "half_open";

interface CircuitConfig {
  failureThreshold: number;  // consecutive failures before opening (default 5)
  cooldownMs: number;        // ms before allowing test call (default 30s)
  name: string;
}

interface CircuitInstance {
  config: CircuitConfig;
  state: CircuitState;
  failures: number;
  lastFailure: number;
  lastSuccess: number;
}

const circuits = new Map<string, CircuitInstance>();

export function createCircuit(config: CircuitConfig): void {
  circuits.set(config.name, {
    config,
    state: "closed",
    failures: 0,
    lastFailure: 0,
    lastSuccess: Date.now(),
  });
}

/** Check if a call is allowed. Returns false if circuit is open. */
export function canCall(name: string): boolean {
  const circuit = circuits.get(name);
  if (!circuit) return true; // no circuit = always allow

  if (circuit.state === "closed") return true;

  if (circuit.state === "open") {
    // Check if cooldown elapsed → transition to half_open
    if (Date.now() - circuit.lastFailure > circuit.config.cooldownMs) {
      circuit.state = "half_open";
      console.log(`[CircuitBreaker] ${name}: OPEN → HALF_OPEN (testing)`);
      return true; // allow one test call
    }
    return false; // still cooling down
  }

  // half_open: allow one test call
  return true;
}

/** Record a successful call. */
export function recordCallSuccess(name: string): void {
  const circuit = circuits.get(name);
  if (!circuit) return;

  circuit.failures = 0;
  circuit.lastSuccess = Date.now();

  if (circuit.state === "half_open") {
    circuit.state = "closed";
    console.log(`[CircuitBreaker] ${name}: HALF_OPEN → CLOSED (recovered)`);
  }
}

/** Record a failed call. */
export function recordCallFailure(name: string): void {
  const circuit = circuits.get(name);
  if (!circuit) return;

  circuit.failures++;
  circuit.lastFailure = Date.now();

  if (circuit.state === "half_open") {
    circuit.state = "open";
    console.log(`[CircuitBreaker] ${name}: HALF_OPEN → OPEN (test failed)`);
    return;
  }

  if (circuit.failures >= circuit.config.failureThreshold) {
    circuit.state = "open";
    console.log(`[CircuitBreaker] ${name}: CLOSED → OPEN (${circuit.failures} consecutive failures)`);
  }
}

/** Get status of all circuits. */
export function getCircuitStatus(): { name: string; state: CircuitState; failures: number }[] {
  return Array.from(circuits.entries()).map(([name, c]) => ({
    name,
    state: c.state,
    failures: c.failures,
  }));
}
