# dotnet-security-reviewer

Read this when a codebase contains C#/.NET server code, ASP.NET Core MVC or minimal APIs, Razor Pages or Blazor, classic ASP.NET, Entity Framework Core, Dapper, SignalR, gRPC, background services, Azure Functions, or .NET message consumers.

For Xamarin or .NET MAUI applications, also load `mobile-security-reviewer.md`. Use this reviewer for shared .NET code and APIs; use the mobile reviewer for platform permissions, deep links, WebViews, device storage, backups, and mobile transport policy.

## Goal

Find exploitable .NET application flaws that API-name matching misses: endpoint authorization gaps, unsafe model binding, EF Core/Dapper raw-query misuse, Razor/Blazor encoding bypasses, weak Data Protection and authentication configuration, unsafe deserialization/XML parsing, SSRF validation bypasses, tenant-context loss, and deployment settings that change runtime security.

## Framework and attack-surface map

Inventory the effective framework, target frameworks, hosting model, and middleware before tracing findings.

| Stack                       | Entry points and security signals                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| ASP.NET Core MVC / API      | `[ApiController]`, `[Controller]`, `[Route]`, `[Http*]`, conventional routes, endpoint metadata, filters, model binders, formatters                   |
| Minimal APIs                | `MapGet`/`MapPost`/`MapMethods`, route groups, endpoint filters, `.RequireAuthorization()`, `.AllowAnonymous()`, parameter binding and `AsParameters` |
| Razor Pages / MVC views     | `PageModel`, `OnGet*`/`OnPost*`, `[BindProperty]`, handlers, tag helpers, `Html.Raw`, partials, antiforgery, view imports                             |
| Blazor Server / WebAssembly | routable components, `[Parameter]`, `[SupplyParameterFromQuery]`, `MarkupString`, JS interop, circuits, prerendering, API authorization               |
| EF Core / Dapper / ADO.NET  | `DbContext`, query filters, raw SQL, interpolated SQL, command parameters, bulk operations, tenancy and concurrency tokens                            |
| Authentication              | Identity, cookies, JWT bearer, OpenID Connect, OAuth, Microsoft.Identity.Web, policy/role/claim handlers, Data Protection                             |
| Realtime / RPC / functions  | SignalR hubs, gRPC services, Azure Functions triggers/bindings, webhooks, queues, scheduled functions                                                 |
| Background work             | `BackgroundService`, hosted services, Hangfire, Quartz.NET, Channels, MassTransit, NServiceBus, Kafka/Rabbit consumers                                |

Inspect `.csproj`, `Directory.Packages.props`, lock/assets files, `Program.cs`, `Startup.cs`, middleware and endpoint registration, `appsettings*.json`, launch profiles, environment variables, `web.config`, Razor files, EF migrations, Identity configuration, Data Protection key storage, reverse-proxy settings, Docker/Kubernetes/IIS configuration, and cloud-function metadata. Environment-specific configuration is part of the effective code path.

## Required review sequence

1. Enumerate every HTTP endpoint, Razor handler, hub method, RPC, function trigger, webhook, queue consumer, scheduled job, file import, and administrative surface.
2. Build an endpoint-to-authentication/authorization/antiforgery matrix from the final middleware and endpoint metadata, not annotations alone.
3. Trace untrusted input through binders, DTO mapping, services, EF/Dapper/ADO.NET, templates, redirects, files, XML/serialization, outbound calls, and asynchronous handoffs.
4. Inspect target-framework and environment-specific behavior, including production configuration and reverse-proxy assumptions.
5. Confirm attacker control, a reachable path, the security consequence, and the missing .NET-specific mitigation before reporting.

Run `python3 scripts/taint_csharp.py` indirectly through the main taint phase when integrated. Treat its output as candidate evidence and read the complete route, service, configuration, and deployment path before confirming.

## Routing, middleware, and authorization

- Reconstruct middleware order. `UseRouting`, authentication, authorization, CORS, forwarded headers, sessions, antiforgery, static files, exception handling, and endpoint mapping are order-sensitive. Confirm `UseAuthorization` executes before the selected endpoint and after routing/authentication.
- Compare attribute routes, conventional routes, route groups, fallback endpoints, Razor handlers, and dynamically mapped endpoints. A controller annotation does not protect a minimal API or hub mapped elsewhere.
- For minimal APIs, follow metadata inherited from route groups and changed by later `.AllowAnonymous()`, `.RequireAuthorization()`, endpoint filters, or conventions. Verify every state-changing route has the intended policy.
- Verify authorization policies authenticate the expected scheme and test the exact claims, issuer, tenant, role, resource owner, and operation. A valid identity is not object-level or tenant-level authorization.
- Inspect custom `IAuthorizationHandler` behavior: failure must stay failed, missing resources/claims must not grant, and handlers must not trust request-supplied owner or tenant fields.
- Check MVC filters, endpoint filters, middleware early returns, SignalR hub filters, gRPC interceptors, and function authorization levels for bypasses and paths that never reach enforcement.
- Enforce object and tenant authorization at the trusted service/repository boundary for every ID lookup, child relation, export, update, delete, bulk operation, and cached result. UI hiding and query-string secrecy are not controls.
- Treat health checks, Swagger/OpenAPI, Hangfire/Quartz dashboards, metrics, profiling, developer exception pages, diagnostic endpoints, GraphQL IDEs, database consoles, and management ports as real endpoints.

## Authentication, sessions, tokens, and Data Protection

- Cookies: verify `Secure`, `HttpOnly`, `SameSite`, domain/path, lifetime, sliding expiration, session fixation, logout invalidation, revocation/security-stamp behavior, and server-side state where required. Proxy TLS termination does not justify accepting attacker-controlled forwarded headers.
- JWT bearer: verify signature algorithm/key selection, issuer, audience, lifetime, clock skew, replay/revocation expectations, and tenant binding. Reject `RequireHttpsMetadata=false` outside a tightly bounded development environment.
- OpenID Connect/OAuth: verify state, nonce, PKCE, callback URI, correlation cookies, token validation, issuer/audience, code redemption, token storage, and logout. Never accept a return URL without `Url.IsLocalUrl`/`LocalRedirect` or an exact trusted allowlist.
- ASP.NET Core Identity: inspect password, lockout, MFA/recovery, email/phone confirmation, token provider lifetime, account enumeration, external-login linking, and privileged role assignment.
- Store Data Protection keys durably and protect them consistently across instances. Ephemeral keys invalidate cookies/tokens; shared unprotected keys allow forgery. Verify application name/purpose isolation, at-rest protection, ACLs, rotation, and disaster recovery.
- For APIs accepting multiple schemes, prove scheme selection cannot downgrade from a stronger policy or confuse cookie and bearer identities.

## CSRF, CORS, hosts, and proxy trust

- Require antiforgery on cookie-authenticated state changes, including Razor handlers, MVC actions, minimal APIs, form endpoints, and JSON endpoints callable by a browser. `[ApiController]` or JSON content does not automatically remove CSRF risk.
- Verify exceptions created by `[IgnoreAntiforgeryToken]`, `.DisableAntiforgery()`, custom middleware, or webhook endpoints. Webhooks need their own cryptographic authentication and replay protection.
- CORS with credentials requires an exact origin allowlist. Flag reflected origins, `SetIsOriginAllowed(_ => true)`, dangerous wildcard subdomain logic, origin suffix checks, or trusting the `Origin` header as authentication.
- Validate `AllowedHosts`, trusted proxies/networks, `ForwardedHeaders`, `KnownProxies`, and header symmetry/limits. Host and forwarded-header poisoning can affect links, redirects, tenant selection, OAuth callbacks, password resets, and security logging.

## Binding, over-posting, and validation

- Treat `[FromQuery]`, `[FromRoute]`, `[FromBody]`, `[FromForm]`, headers, cookies, minimal-API scalar/DTO parameters, `[AsParameters]`, `[BindProperty]`, `[SupplyParameterFromQuery]`, hub/RPC arguments, function bindings, and deserialized messages as untrusted.
- Flag binding directly into EF entities, Identity models, principals, or domain objects with `Id`, `TenantId`, `OwnerId`, `Role`, `Claims`, `IsAdmin`, `Enabled`, `Status`, price/balance, approval, concurrency, or audit fields.
- Prefer purpose-built input DTOs and explicit mapping. `[Bind]`, `BindNever`, JSON ignore/access settings, and custom model binders must apply to the exact path; validation attributes constrain values but do not prevent privileged fields from binding.
- Check custom `IModelBinder`, JSON converters, polymorphic DTOs, `TryUpdateModelAsync`, AutoMapper profiles, patch documents, and merge/update helpers for hidden writable properties.
- Enforce request/body/multipart limits while streaming. Verify upload filename generation, content checks, storage outside executable/static roots, archive extraction limits, and authorization on download/delete.

## SQL, EF Core, Dapper, and tenancy

- ADO.NET command text must be structurally fixed and values bound through typed parameters. String concatenation/interpolation before `SqlCommand`, `NpgsqlCommand`, `MySqlCommand`, `OleDbCommand`, or `.CommandText` is injectable even if `ExecuteReader` occurs later.
- EF Core: `FromSqlInterpolated` and `ExecuteSqlInterpolated` bind interpolation values. Interpolating into `FromSqlRaw`, `ExecuteSqlRaw`, `SqlQueryRaw`, or dynamically built identifiers/order clauses does not. Composite placeholders are safe only when values are passed separately.
- Dapper: fixed SQL plus an anonymous object or `DynamicParameters` binds values. Interpolated/concatenated SQL and user-controlled identifiers/fragments remain vulnerable. Check third-party interpolated-string handlers by their actual behavior.
- LINQ expression trees generally bind values, but `FromSql*`, raw command execution, dynamic-LINQ strings, manually constructed expressions, and stored procedures with dynamic SQL need tracing.
- Verify tenant filters apply to reads, writes, includes, raw SQL, bulk update/delete, migrations/seed code, caches, background jobs, and administrators' delegated views. Check `IgnoreQueryFilters`, context pooling, mutable tenant services, and singleton/static context leaks.
- Review optimistic concurrency and transactions around balances, inventory, quotas, approvals, one-time tokens, and state machines. A checked-then-updated row without an atomic condition or concurrency token is raceable.

## Razor, Blazor, JavaScript interop, and XSS

- Razor encodes ordinary `@value` output. Trace input into `Html.Raw`, `HtmlString`, custom `IHtmlContent`, tag-helper output marked HTML-safe, unsafe JSON in script contexts, email/template renderers, and dynamic partial/view names.
- Blazor encodes normal text rendering. `(MarkupString)value` and `new MarkupString(value)` bypass encoding. Trace component/query/route/API/JS-interoperability data into those casts and into browser DOM APIs.
- Encoding must match the output context: HTML text, attribute, URL, JavaScript, CSS, and JSON contexts differ. Generic replacement or input filtering is not equivalent to context-aware encoding.
- Review JS interop calls that pass attacker data to `eval`, HTML insertion, navigation, storage, postMessage, or script loaders. Treat browser-returned JS interop values as untrusted on the server.
- For Blazor Server, verify circuit identity/tenant state, reconnection, per-user scoped services, sensitive prerendered state, SignalR limits, and that authorization is rechecked in server operations rather than only in component rendering.

## Commands, files, archives, and redirects

- Trace input into `Process.Start`, `ProcessStartInfo.FileName`, `Arguments`, shell commands, PowerShell, `cmd /c`, `sh -c`, scripting engines, compilers, and plugin/assembly loading. `ArgumentList` avoids shell tokenization but does not prevent attacker-selected executables, dangerous options, or program-specific injection.
- For paths, resolve against an absolute trusted base with `Path.GetFullPath`, then enforce containment using path-aware comparison and the correct platform case semantics. Account for rooted paths, alternate separators, UNC/device paths, symlinks/reparse points, and check/use races.
- For ZIP/TAR extraction, validate every resolved entry, symlink/hardlink, duplicate, nested archive, expanded size, count, compression ratio, destination race, and overwrite behavior.
- Use `LocalRedirect` or validate with `Url.IsLocalUrl`; for external redirects use exact scheme/host/port allowlists after canonical parsing. Prefix/suffix/substring tests are bypassable.
- Prevent response splitting and unsafe download names with framework header APIs and validated filenames; verify `Content-Disposition` behavior across browsers.

## SSRF and outbound clients

Trace destinations into `HttpClient`, typed/named clients, `HttpRequestMessage`, `WebRequest`, `WebClient`, SDK clients, webhook delivery, image/document fetchers, and redirects.

- Parse once with `Uri`; allow only required schemes and exact normalized hosts/ports. Reject user-info, opaque forms, unexpected Unicode/IDN names, IP literal encodings, loopback, private, link-local, multicast, unspecified, and cloud metadata destinations.
- Resolve and connect to the validated destination without an untrusted re-resolution gap. Revalidate every redirect or disable redirects. A host allowlist without DNS/IP handling may still permit rebinding.
- Apply connection, total, and read timeouts; limit redirects, response bytes, decompression, and concurrent requests. `IHttpClientFactory` improves lifetime management but does not validate URLs.
- Check proxy environment variables and handler configuration; a trusted URL sent through an attacker-controlled proxy is not safe.

## Deserialization, XML, and dynamic execution

- Treat `BinaryFormatter`, `SoapFormatter`, `NetDataContractSerializer`, `LosFormatter`, `ObjectStateFormatter`, and legacy remoting serializers as unsafe for untrusted data. Binder/type allowlists are fragile; remove the format or authenticate data before parsing where migration is unavoidable.
- Newtonsoft.Json: `TypeNameHandling` other than `None` can instantiate attacker-selected types. Verify a strict binder, constrained root types, all serializer instances/settings, and the trust boundary. Ordinary `JsonConvert.DeserializeObject<T>` into a sealed DTO is not automatically unsafe.
- System.Text.Json polymorphism requires an explicit, narrow derived-type model. Inspect custom converters, discriminator handling, type resolution, depth/size limits, reference preservation, and extension-data handling.
- XML: set `DtdProcessing` to `Prohibit`/`Ignore`, `XmlResolver=null`, and appropriate size/depth limits on the actual reader before parsing. Trace `XmlDocument`, `XDocument`, `XPathDocument`, serializers, schema/transform resolution, and custom resolvers.
- Trace input into Razor runtime compilation, RazorLight, Scriban/Liquid templates, Roslyn compilation, reflection, `Assembly.Load*`, expression/dynamic-LINQ engines, and PowerShell. Sandboxing claims require an enforceable runtime boundary.

## Cryptography, TLS, and secrets

- Reject MD5/SHA-1 for signatures/security hashes, DES/3DES/RC2, ECB, unauthenticated encryption where integrity matters, predictable `Random`, reused/static IVs/nonces, hardcoded keys, and weak password derivation. Prefer platform-approved AEAD and password hashing.
- Verify `CryptographicOperations.FixedTimeEquals` for secret/MAC comparisons where timing matters and that signatures bind purpose, algorithm, key, tenant, audience, and expiry.
- Flag `DangerousAcceptAnyServerCertificateValidator`, callbacks that always return true, disabled hostname validation, weak protocols, and clients that bypass the configured secure handler.
- Review user-secrets, environment variables, Key Vault/secret-store integration, appsettings, publish artifacts, logs, crash dumps, diagnostic endpoints, and Data Protection storage. Development secret mechanisms are not production secret stores.

## Async, background, SignalR, gRPC, and cloud functions

- `HttpContext`, scoped services, transactions, culture, logging scope, and tenant state do not remain safe after a request ends or when captured into background work. Copy only required trusted data and create a fresh scope.
- Verify queue/job provenance, tenant/object authorization, replay/idempotency, retry/dead-letter behavior, serialization limits, and secret/PII handling. Do not derive authorization solely from a mutable message payload.
- SignalR: authorize hubs and sensitive methods, validate group membership/user identifiers, bound message sizes/rates, and avoid trusting client-supplied connection/user IDs. Recheck authorization when permissions can change during long-lived connections.
- gRPC: inspect interceptors and per-method policies, streaming limits/cancellation, metadata authentication, reflection exposure, and tenant context across streams.
- Azure Functions: verify `authLevel`, platform/Easy Auth assumptions, function/host key exposure, webhook signature validation, trigger authorization, storage-account access, and admin endpoints. A function key is often shared bearer access, not user authorization.
- Bound channels, queues, task fan-out, regex work, database result sizes, uploads, XML/JSON depth, decompression, and outbound responses. Honor cancellation and avoid sync-over-async/thread-pool starvation.

## Evidence and false-positive requirements

For every reported finding, provide:

1. The concrete route/handler/message/function and attacker-controlled value.
2. The complete data/control path through binding, mapping, services, async work, and configuration.
3. The exact sink or violated security property.
4. The missing/bypassed .NET mitigation and target-framework behavior.
5. The deployment conditions, reachable impact, and confidence.

Before confirming, rule out these common non-findings:

- Fixed SQL with ADO.NET parameters, Dapper parameter objects, EF LINQ binding, `FromSqlInterpolated`, or raw-SQL composite placeholders with separate arguments.
- Normal Razor/Blazor text rendering without `Html.Raw`, `MarkupString`, or another encoding bypass.
- `LocalRedirect`, a proven `Url.IsLocalUrl` branch, or an exact canonical external-destination allowlist.
- A path canonicalized and proven contained beneath a trusted base on the relevant platform.
- An outbound URI whose scheme, host/port, resolved addresses, and every redirect are all constrained.
- `System.Text.Json`/Newtonsoft deserialization into a fixed data-only type without polymorphic type loading.
- XML parsed by the actual securely configured reader with DTD/external resolution disabled.
- A dangerous API that is unreachable from untrusted input or exists only in test/development code excluded from production.

If source-to-sink reachability, middleware order, target framework, runtime configuration, or deployment exposure cannot be proven, keep the item as a candidate and state exactly what evidence is missing.
