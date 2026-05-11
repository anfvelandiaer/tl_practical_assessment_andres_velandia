# Technical Decision Record: Digital Direct Channel Strategy


## 1. Context & Problem Statement
We are deploying a multi-country Digital Direct Channel. We must define a governance model and communication patterns that ensure high availability, scalability, and rapid time-to-market across different regions without creating technical bottlenecks.

---

## 2. Integration Governance: Federated vs. Centralized
* **Option A: Centralized:** One central team handles all development. (Rejected: Becomes a bottleneck for multi-country rollouts).
* **Option B: Federated:** Decentralized teams own integrations, supported by a Center for Enablement (C4E). (**Selected**: Maximizes autonomy and regional speed).

**Rationale:** To scale effectively, country-specific teams must own their delivery. The C4E provides reusable assets (Salesforce System APIs, security templates) to ensure global consistency while allowing local execution.

---

## 3. Communication Patterns: Event-Driven vs. Synchronous
* **Option A: Synchronous:** Real-time RESTful request-response. (Limited Use: Only for read-only lookups like quotes).
* **Option B: Event-Driven (EDA):** Asynchronous messaging via Anypoint MQ. (**Selected**: Standard for all critical persistence flows).

**Rationale:** In Insurtech, "Policy Issuance" and "Payments" are mission-critical. EDA decouples the frontend from core, ensuring that even if the core is under load, transactions are queued and guaranteed to process, preventing data loss and providing a resilient user experience.

---

## 4. Consequences & Risks
* **Positive:**
    * **Resilience:** High availability; systems remain functional during downstream maintenance.
    * **Scalability:** Independent scaling of regional workloads.
    * **Autonomy:** Faster local delivery cycles.
* **Negative:**
    * **Complexity:** Requires advanced observability (OpenTelemetry) to track asynchronous flows.
    * **Consistency:** Moves to an eventual consistency model for backend updates, requiring UI status-handling logic.