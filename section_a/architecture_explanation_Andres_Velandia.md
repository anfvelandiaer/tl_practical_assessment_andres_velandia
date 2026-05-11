# Section A: Target Architecture Explanation

## 1. Architectural Overview: API-Led Connectivity

To support a **multi-country Digital Direct Channel**, the architecture is based on the **API-Led Connectivity** paradigm. This approach decouples the frontend experience from the core systems of record, specifically **Salesforce**, ensuring agility and reuse across different regions.

* **Experience APIs**: Tailored for specific country requirements (e.g., local mobile apps or web portals), providing optimized data contracts.
* **Process APIs**: Encapsulate common business logic such as "Premium Calculation" or "Claims Orchestration," allowing for regional consistency.
* **System APIs**: Standardize access to **Salesforce** and third-party services (Payment Gateways, Identity Verification), shielding the rest of the ecosystem from downstream complexity.

## 2. High Availability and Scalability

The solution is designed for **High Availability (HA)** and elastic growth:

* **Multi-AZ Deployment**: Services are deployed across multiple Availability Zones using **MuleSoft Runtime Fabric (RTF)** on Kubernetes to ensure zero downtime.
* **Horizontal Autoscaling**: Automated scaling based on CPU/Memory metrics to handle traffic spikes during peak insurance campaign periods.
* **Global Traffic Management**: A Cloud-based Load Balancer/WAF manages entry points, routing users to the nearest regional instance to minimize latency.

## 3. Resilience and Integration Patterns

To meet the rigorous reliability requirements of an **Insurtech** platform, the following patterns are implemented:

* **Bulkheads (Isolating Failure)**: Resources (vCores/Threads) are isolated by country and by service. A failure or traffic surge in Colombia will not saturate the resources reserved for Mexico, maintaining global stability.
* **Circuit Breaker (Self-Healing)**: Applied to all outgoing calls to third-party providers (e.g., Payment Gateways, Identity Verification). If a service fails, the circuit opens to prevent cascading failures and resource exhaustion.
* **Asynchronous Messaging (Guaranteed Delivery)**: Mission-critical flows like **Policy Issuance** are handled via **Event-Driven Architecture (EDA)** using Anypoint MQ. This ensures that even if Salesforce is temporarily under load, the transaction is queued and eventually processed.
* **Idempotency Key Support**: Implemented for all persistence operations in Salesforce to prevent duplicate records (e.g., double charging or double policy issuance) during automatic retries.
* **Retries with Exponential Backoff and Jitter**: Used for transient network failures to avoid "thundering herd" scenarios against the Salesforce API.
* **Caching Strategy**: Distributed caching (Object Store/Redis) is utilized in the Process layer to store quote results and static metadata, reducing unnecessary load on the core systems.
* **Identity Verification (KYC)**: Exposed as a dedicated System API with its own circuit breaker. In an Insurtech platform, identity validation is critical during onboarding and policy issuance flows; isolating it ensures that a failure from an external KYC provider does not impact other system flows.

## 4. Observability and Operations

The architecture prioritizes **full-stack observability**:

* **OpenTelemetry Integration**: Standardized trace propagation across all layers, enabling end-to-end transaction tracking from the Digital Channel to Salesforce.
* **Correlation ID Policy**: All requests receive a unique identifier that is propagated through every layer (Experience → Process → System → Salesforce), facilitating diagnosis of distributed errors.
* **Real-Time Health Dashboards**: Monitoring of regional traffic, error rates, and per-service latency, with alerts configured on critical thresholds.
* **Chaos Engineering (Phase 3)**: Execution of chaos drills to validate system behavior under failure conditions using a simulated flaky upstream service. This confirms that circuit breakers, bulkheads, and retries perform correctly in production.

---

> **Note**: See the attached architecture diagram for the end-to-end visual representation of all components, layers, and patterns described in this document.
