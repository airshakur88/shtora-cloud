# java-security-reviewer

Read this when a codebase contains Java or Kotlin/JVM server code; Spring Boot, Spring MVC, Spring Security, or Spring Data; Jakarta EE, Servlets, or JAX-RS; Struts; JSF; Hibernate/JPA; Micronaut; Quarkus; JVM message consumers; or JVM workers that process untrusted data.

For Android applications, also load `mobile-security-reviewer.md`. Use this reviewer for shared Java/Kotlin code and JVM APIs; use the mobile reviewer for manifests, components, deep links, WebViews, device storage, backups, and platform permissions.

## Goal

Find Java/JVM vulnerabilities that generic pattern matching misses: annotation and route-coverage gaps, framework binding into privileged fields, expression-language injection, unsafe serialization and XML processing, ORM misuse, URL-validation bypasses, management endpoint exposure, and security-context loss across asynchronous or tenant boundaries.

## Framework and attack-surface map

Inventory the framework before tracing findings. Treat all externally supplied values as untrusted, including data loaded later from a database, queue, cache, object store, or identity-provider claim.

| Stack | Entry-point and security signals |
|---|---|
| Spring MVC / Boot | `@Controller`, `@RestController`, `@RequestMapping`, `@*Mapping`, `@RequestParam`, `@PathVariable`, `@RequestBody`, `@ModelAttribute`, multipart handlers, `HandlerInterceptor`, `OncePerRequestFilter` |
| Spring Security | `SecurityFilterChain`, `requestMatchers`, `securityMatcher`, `permitAll`, `WebSecurityCustomizer`, `@PreAuthorize`, `@PostAuthorize`, `@Secured`, `@RolesAllowed`, OAuth2 resource-server and login configuration |
| Jakarta EE / Servlet | `HttpServlet`, `doGet`/`doPost`/`service`, filters, listeners, `web.xml`, `@ServletSecurity`, `@RolesAllowed`, request parameters, headers, cookies, parts, input streams |
| JAX-RS / Jersey / RESTEasy | `@Path`, `@GET`/`@POST`/other method annotations, `@PathParam`, `@QueryParam`, `@HeaderParam`, `@CookieParam`, `@FormParam`, `@BeanParam`, entity-body parameters, request filters |
| Struts | `ActionSupport`, action mappings, public setters populated from requests, interceptors, result redirects, OGNL expressions, dynamic method invocation |
| JSF | managed/CDI beans, action methods, request/view/session scoped state, `f:viewParam`, converters, validators, Unified EL, Facelets output and `escape="false"` |
| Hibernate / JPA | repositories, `EntityManager`, `Session`, JPQL/HQL/native SQL, entity listeners, converters, tenant filters, caches, lifecycle callbacks |
| Micronaut / Quarkus | `@Controller`, HTTP method annotations, `@Body`, `@QueryValue`, `@PathVariable`, Jakarta REST resources, security annotations, reactive routes, scheduled/event consumers |
| Ktor | `routing {}`, `get`/`post`/other route builders, `authenticate`, `call.parameters`, `call.receive<T>()`, plugins/interceptors, Ktor Resources, sessions, WebSockets, content negotiation |
| Async / messaging | `@Async`, `CompletableFuture`, executors, Reactor, virtual threads, `@Scheduled`, JMS/Kafka/Rabbit listeners, retry/dead-letter handlers, batch jobs, gRPC methods |

Also inspect `pom.xml`, Gradle files and version catalogs, `application*.properties`/YAML, `web.xml`, persistence configuration, security configuration, templates, logging configuration, keystores, and deployment descriptors. Framework auto-configuration is part of the effective attack surface even when there is little application code.

## Required review sequence

1. Enumerate every HTTP, RPC, message, scheduled, file-import, and administrative entry point.
2. Map the effective authentication and authorization rule for each entry point, including filter-chain ordering and method-level checks.
3. Trace untrusted data through binding, DTO-to-domain copying, services, repositories, templates, outbound calls, files, parsers, and asynchronous handoffs.
4. Inspect configuration that can enable, expose, or weaken the code path.
5. Confirm source, consequence, reachable path, and missing JVM-specific mitigation. A dangerous API or dependency alone is only a candidate.

## Authentication and authorization

### Spring Security

- Build an endpoint-to-rule matrix. Multiple `SecurityFilterChain` beans are ordered; the first matching chain wins. Check gaps from `securityMatcher`, `requestMatchers`, MVC/path semantics, trailing slashes, servlet context paths, forwarded prefixes, HTTP methods, and dispatcher types.
- Treat `permitAll`, `web.ignoring`, broad static-resource matchers, catch-all rules, and custom filters that return early as high-risk. Verify newly added routes are covered by the intended chain.
- Verify method security is enabled before relying on `@PreAuthorize`, `@Secured`, or `@RolesAllowed`. Trace proxy bypass through self-invocation, non-managed objects, final/private methods where relevant, and calls to an unannotated overload.
- Check role/authority semantics (`ROLE_` prefixes, scopes versus roles, `hasRole` versus `hasAuthority`) and whether claims are mapped from a trusted issuer.
- For sessions, verify fixation protection, logout invalidation, remember-me key handling, concurrency policy, timeout, cookie `Secure`/`HttpOnly`/`SameSite`, and CSRF protection on every state-changing browser path. Disabling CSRF is not automatically safe merely because some endpoints accept bearer tokens.
- For JWT/OIDC, verify signature and algorithm policy, issuer, audience, expiry/not-before, key selection, refresh/revocation behavior, and tenant/organization binding. Do not trust a role, tenant, or subject claim merely because the token parsed successfully.
- CORS with credentials requires an exact trusted-origin policy; wildcard or reflected origins can expose authenticated responses.

### Jakarta EE and framework authorization

- Compare annotations and deployment descriptors. Verify URL patterns and HTTP-method constraints have no uncovered methods and that filters apply to forwards, includes, errors, and async dispatch where intended.
- In JAX-RS, verify resource sub-locators and inherited/interface annotations preserve the expected security rule.
- In Struts and JSF, verify action methods and navigation outcomes are server-authorized; disabling or hiding a component is not authorization.
- For every lookup by object ID, enforce object-level and tenant-level authorization in the same server-side transaction or trusted service boundary. `findById`, repository method names, and entity ownership fields do not enforce access control by themselves.

### Ktor

- Map nested `route`/`authenticate`/`authorize` blocks in effective order. A sibling route or route installed outside an `authenticate` block is not protected by that block. Verify provider names, optional authentication, challenge behavior, and custom principals.
- Treat `call.principal`, a valid session, or a decoded JWT as identity only. Enforce object, tenant, and privileged-property authorization in the handler/service using server-derived actor context.
- For cookie sessions, review signing/encryption keys, cookie attributes, fixation/rotation, logout invalidation, CSRF on state changes, and trusted proxy/origin configuration. For bearer tokens, apply the same issuer/audience/expiry/tenant checks as other JVM stacks.

## Binding and mass assignment

Flag request binding directly into JPA entities, security principals, or domain objects with privileged fields:

- Spring `@RequestBody`/`@ModelAttribute`, `WebDataBinder`, Jackson creators/setters, `ObjectMapper.convertValue`, and `BeanUtils.copyProperties`.
- JAX-RS/Micronaut/Quarkus entity bodies and bean parameters.
- Ktor `call.receive<T>()`, `receiveParameters`, multipart parts, Resources DTOs, and content-converter deserialization.
- Struts public setters and nested OGNL property binding.
- JSF editable value bindings into session/domain objects.

Trace whether a caller can set `id`, `tenantId`, `ownerId`, `role`, `authorities`, `enabled`, `status`, `price`, `balance`, approval state, or audit fields. Prefer purpose-built request DTOs and explicit field mapping. If `allowedFields`/`disallowedFields`, Jackson ignore/access rules, validation groups, or allowlisted copy logic exists, verify the exact binder and update path uses it. Bean Validation constrains values; it does not by itself prevent binding to a sensitive field.

## Expression, template, and code injection

- SpEL: trace untrusted strings to `SpelExpressionParser`, `ExpressionParser.parseExpression`, `StandardEvaluationContext`, `@Value`, or dynamically assembled `@PreAuthorize`/query expressions. `StandardEvaluationContext` permits powerful type, method, constructor, and bean resolution unless explicitly restricted; prefer fixed expressions and `SimpleEvaluationContext` where dynamic evaluation is truly required.
- Struts/OGNL: inspect action names, parameters, `%{...}`, `${...}`, dynamic method invocation, excluded patterns/classes/packages, and custom interceptors. Do not assume a patched Struts version makes application-created OGNL evaluation safe.
- JSF/Jakarta EL: trace input to `ELProcessor.eval`, `ExpressionFactory`, `ValueExpression`, `MethodExpression`, or any second evaluation of a user-controlled expression.
- Template engines: check Thymeleaf preprocessing and dynamic view names/fragments, FreeMarker `Template` from strings, Velocity, Pebble, Groovy, MVEL, scripting engines, and user-authored templates. Framework auto-escaping protects only the correct output context and can be bypassed by raw/unescaped output features.
- Reflection and class loading: trace attacker-controlled class/method names, JAR/plugin paths, `Class.forName`, method invocation, scripting, compiler APIs, and JNDI lookups. JNDI names/provider URLs influenced by users can cause unauthorized lookups or outbound access even when remote class loading is disabled.

## Database and ORM review

- JDBC: `PreparedStatement` is safe for values only when the SQL structure is fixed and values use bind methods. Concatenating before `prepareStatement`, allowing user-selected identifiers/sort fragments without an allowlist, or invoking a stored procedure with dynamic SQL remains vulnerable.
- JPA/Hibernate: trace input to `createQuery`, `createNativeQuery`, legacy `createSQLQuery`, HQL/JPQL, Criteria literal/raw fragments, filters, specifications, and repository `@Query`. Named/positional parameter binding is the expected mitigation; string concatenation or expression-generated query structure is not.
- Spring JDBC and jOOQ: verify `JdbcTemplate`/`NamedParameterJdbcTemplate` values are bound, and that plain/raw SQL templates or fields are not built from request data. DSL use is not proof that every embedded fragment is safe.
- Check second-order injection where a stored display name, report filter, integration field, or import value later becomes a query fragment.
- Check tenant isolation in every repository/native query, bulk update/delete, relation traversal, and cache key. Hibernate filters or a tenant resolver must be active in async jobs, administrators' delegated views, and background consumers as well as HTTP requests.

## Deserialization and parser security

### Object and data deserialization

- Trace untrusted bytes to `ObjectInputStream.readObject`, RMI/JMX/JMS object messages, HTTP sessions/caches using native serialization, `XMLDecoder`, XStream, Hessian, Kryo, FST, SnakeYAML object construction, or other polymorphic formats.
- For Jackson, review legacy/default typing, permissive polymorphic type validators, attacker-controlled type metadata, broad base classes such as `Object`, custom deserializers, and `ObjectMapper` variants with different configuration. Jackson use alone is not a finding.
- Prefer data-only formats and explicit DTOs. Where native serialization cannot be removed, verify JEP 290 filters or equivalent allowlists, size/depth/reference limits, and that the filter is applied to the actual stream before object creation. Gadget absence in a quick dependency search is not a durable mitigation.

### XML and related factories

Review the actual configured factory/parser used at the sink:

- DOM/SAX: disable DOCTYPE and external general/parameter entities; disable XInclude; avoid entity expansion.
- StAX: disable DTD support and external entities.
- `TransformerFactory`, `SchemaFactory`, `SAXTransformerFactory`, and validators: restrict external DTD and stylesheet/schema access.
- JAXB: secure the parser or XML reader that feeds unmarshalling rather than assuming JAXB is safe by default.

Confirm settings occur before parsing on every code path. System properties or configuration on an unused factory do not mitigate the real sink. Include entity-expansion and oversized document denial of service, not only file disclosure and SSRF.

## SSRF and URL handling

Trace URLs into Java `HttpClient`, `URLConnection`, Apache HttpClient, OkHttp, Spring `RestTemplate`/`WebClient`, JAX-RS clients, image/document fetchers, webhooks, and redirects.

- Parse once with `URI`; require an allowed scheme and expected host/port. Reject user-info, opaque/malformed forms, forbidden IP literals, ambiguous encodings, and unexpected Unicode/IDN hostnames.
- Resolve the destination and reject loopback, link-local, private, multicast, unspecified, and cloud metadata ranges as appropriate. Connect using a value bound to the validated destination so DNS rebinding or later re-resolution cannot switch targets.
- Disable redirects or revalidate every redirect target. Limit redirects, response size, decompression, and timeouts.
- Block non-HTTP protocols and handlers such as `file:` or `jar:` unless explicitly required. A string prefix/suffix check, regex over the raw URL, or validation of only the first redirect is insufficient.
- For open redirects and forwards, allowlist local destinations and normalize before comparison. Check Spring view names such as `redirect:`/`forward:`, servlet `sendRedirect`, JAX-RS `Response.seeOther`, and framework navigation outcomes.

## Files, archives, uploads, and commands

- For path traversal, resolve user input against an absolute trusted base, normalize/canonicalize, then enforce `candidate.startsWith(base)` as `Path` components. Check symlinks and race-resistant open behavior where attackers can modify the filesystem. String-prefix checks and `normalize()` without containment are insufficient.
- For ZIP, JAR, TAR, and other archive extraction, validate every entry after resolution (Zip Slip), including mixed separators, absolute paths, drive/UNC paths, symlinks/hardlinks, duplicate entries, nested archives, and extraction races. Enforce entry count, total expanded bytes, compression ratio, nesting, and disk quotas.
- For uploads, verify size before and during streaming, filename generation, type/content validation, storage outside executable/static roots, archive handling, authorization, malware policy where required, and safe download headers.
- Trace input into `Runtime.exec` and `ProcessBuilder`. Shell metacharacters become shell injection when a shell (`sh -c`, `cmd /c`, PowerShell) is invoked; without a shell, attacker control of the executable or arguments can still enable option/argument injection or arbitrary program execution. An argument list is not safe if the invoked program interprets attacker-controlled options, scripts, or paths.

## Cryptography and TLS

- Reject security uses of MD5/SHA-1, DES/3DES/RC4, ECB, unauthenticated encryption where integrity is required, predictable `java.util.Random`, static/reused IVs or GCM nonces, hardcoded keys, and password-derived keys without an approved KDF configuration.
- Verify encryption and signature algorithms include an explicit secure transformation; provider defaults must not silently select ECB or weak padding.
- Verify signature checks fail closed and bind the full security-relevant payload, algorithm, key ID, tenant, audience, purpose, and expiry. Compare signer and verifier canonicalization.
- Flag trust-all `X509TrustManager`, permissive `HostnameVerifier`, `NoopHostnameVerifier`, disabled certificate checks, weak protocol/cipher overrides, and clients that silently fall back from HTTPS. Verify trust stores, pinning/rotation policy where used, and hostname verification apply to the actual client instance.
- Treat keystore/truststore passwords, private keys, salts, and tokens as secrets. Confirm secrets are not committed, logged, exposed through management endpoints, or reused across environments.

## Logging, errors, and management surfaces

- Trace credentials, bearer tokens, session IDs, reset links, authorization headers, cookies, payment/health data, secrets, full request bodies, and sensitive query parameters into SLF4J/Log4j/JUL, audit events, traces, metrics tags, and exception handlers.
- Parameterized logging avoids accidental format handling but does not prevent sensitive-data exposure or log forging. Normalize or encode CR/LF where logs cross a trust boundary, and verify structured fields cannot break downstream parsers.
- Review custom exception mappers, Spring error attributes, stack traces, SQL errors, validation details, object `toString`, and differential errors that permit enumeration.
- Treat vulnerable logging libraries and message-lookup behavior as a dependency/reachability question; a log statement alone is not proof of code execution.
- Check Spring Boot Actuator and equivalent admin surfaces: `env`, `configprops`, `heapdump`, `threaddump`, `mappings`, `beans`, `loggers`, `shutdown`, Jolokia, JMX, H2 console, Swagger/OpenAPI consoles, framework dev UIs, and diagnostic endpoints. Verify actual exposure/include rules, bind address/management port, network controls, authentication/authorization, CSRF for mutations, and health-detail policy. Presence of the dependency alone is not a finding.

## Async, reactive, and tenant boundaries

- `SecurityContext`, tenant context, transaction state, MDC, locale, and other `ThreadLocal` data do not automatically cross `@Async`, custom executors, `CompletableFuture`, parallel streams, scheduled tasks, or manually created/virtual threads. Verify an explicit trusted context is propagated and cleared after use.
- In Reactor/Mutiny and other reactive paths, verify security and tenant identity is carried in the reactive context rather than assumed from a thread. Check context loss at blocking bridges, callbacks, retries, and scheduler changes.
- Message consumers and batch jobs must authenticate message provenance, authorize the referenced tenant/object, handle replay/idempotency, and derive tenant scope from trusted envelope data rather than a mutable payload field.
- Verify retry and dead-letter paths preserve authorization, confidentiality, and tenant routing. Exceptions, metrics, caches, and queue names must not leak one tenant's data to another.
- Check transaction boundaries and optimistic/pessimistic locking around balances, inventory, approvals, one-time tokens, quota, and state transitions. A pre-check followed by a separate update is raceable.
- Bound executor queues, concurrency, request/body size, parser depth, regex work, result sets, pagination, archive expansion, and outbound response sizes. Check blocking I/O on event loops in WebFlux, Vert.x, Micronaut, and Quarkus reactive code.

## Framework-specific quick checks

### Spring Boot / MVC / Data

- Security chain and method-security coverage; CSRF/CORS/session policy; `ForwardedHeaderFilter` and trusted proxies.
- `@RequestBody`/`@ModelAttribute` mass assignment; raw repository/JPA/JDBC fragments; dynamic view names and SpEL.
- Actuator/admin/debug exposure; environment-specific property overrides; dev profiles accidentally active in production.

### Jakarta EE / Servlet / JAX-RS

- Servlet/filter mapping and dispatch types; security-constraint method omissions; async request handling.
- Request/response splitting, untrusted forwards/redirects, multipart limits, unsafe parser/provider configuration, and resource sub-locator authorization.

### Struts / JSF

- OGNL/EL evaluation and property binding; action/method exposure; insecure results/navigation; unescaped component/template output; server-side view state integrity and secret handling.

### Micronaut / Quarkus

- Annotation coverage and deny-by-default behavior; build-time versus runtime config; native-image reflection/serialization registration; dev/admin endpoints; reactive context and blocking boundaries.

### Ktor

- Nested routing/authentication coverage; typed `call.receive<T>()` does not authorize sensitive fields or impose size/depth limits by itself.
- Content negotiation/deserialization limits, multipart streaming and cleanup, WebSocket/message authorization, StatusPages error exposure, CORS/CSRF/session cookies, forwarded headers, and development plugins.
- Exposed, jOOQ, JDBC, Hibernate, and raw driver query construction; Ktor has no automatic SQL safety for downstream persistence APIs.
- `HttpClient` destination/redirect validation, response limits/timeouts, file responses/uploads, HTML builders/templates, coroutine context propagation, and blocking I/O on event-loop dispatchers.

## Evidence and false-positive requirements

For every reported finding, provide:

1. The concrete entry point and attacker-controlled value.
2. The complete call/data path, including DTO mapping, service/repository calls, callbacks, or async/message handoffs.
3. The exact sink or security consequence and its runtime configuration.
4. The missing or bypassed framework/JVM mitigation.
5. The reachable deployment conditions and realistic impact.

Before confirming, verify these common non-findings:

- A fixed SQL/JPQL/HQL template with bound parameters is not injection.
- A request DTO with explicit field mapping is not mass assignment merely because it uses Jackson.
- `ObjectMapper`, XML factories, Actuator dependencies, `Runtime.exec`, and HTTP clients are candidates until untrusted reachability and unsafe effective configuration are proven.
- `ProcessBuilder(List<String>)` avoids shell parsing only when no shell is invoked; still assess executable and argument semantics.
- XML hardening must configure the exact parser instance before use.
- URL validation must cover resolved destinations and redirects, not just the original string.
- Spring Security must be evaluated using effective chain order, matcher coverage, and enabled method security, not the presence of annotations or dependencies.

Pass all candidates through `false-positive-filter.md` before reporting.
