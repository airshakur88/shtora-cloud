# ruby-security-reviewer

Read this when a codebase contains Ruby web/server code, Ruby on Rails, Sinatra, Hanami, Rack applications or middleware, Active Record/ROM/Sequel, background jobs, ERB/Haml/Slim templates, or Ruby upload/import workers.

## Goal

Find exploitable Ruby web-application vulnerabilities that generic pattern matching misses: callback and route authorization gaps, unsafe strong-parameter/model binding, raw ORM fragments, escape bypasses, Rack/session mistakes, SSRF and redirect validation gaps, unsafe serialization, file/archive/upload flaws, and tenant context loss across jobs.

## Framework and attack-surface map

| Stack | Entry-point and security signals |
|---|---|
| Rails | `config/routes.rb`, controllers/concerns, `before_action`, policies, models/scopes, serializers, mailers, channels, Active Job, Action Cable, Active Storage, ERB/Haml/Slim |
| Sinatra / Rack | route blocks, mounted apps, `before` filters, helpers, Rack middleware order, sessions/cookies, Rack::Protection, template helpers, custom authentication |
| Hanami | `config/routes.rb`, app/slice actions, action parameter contracts, Rack middleware, providers/dependencies, ROM relations/repositories, views/templates, settings, command/queue consumers |
| Data/jobs | Active Record, Sequel, raw adapters, Sidekiq, Resque, Delayed Job, Solid Queue, scheduled tasks, event consumers |

Also inspect `Gemfile`/lock, environment files, initializers, credentials handling, session/cookie configuration, proxy/host settings, storage adapters, route constraints, template settings, and production error/debug behavior.

Treat parameters, headers, cookies, uploaded files, database content, serialized cookies/jobs, queue messages, webhooks, imported archives, and third-party API values as untrusted until provenance and integrity are proven.

## Required review sequence

1. Enumerate HTTP, WebSocket/channel, webhook, admin, upload, import, console/task, and background-job entry points.
2. Build a route/action-to-authentication, authorization, CSRF, and tenant-control matrix, accounting for callbacks and middleware order.
3. Trace untrusted values through strong parameters, models, SQL, templates, outbound HTTP, redirects, files, archives, deserializers, processes, logs, and jobs.
4. Evaluate effective runtime configuration and framework version rather than inferring safety from a gem or helper name.
5. Confirm a reachable source, consequence, missing/bypassed mitigation, actor privileges, and deployment conditions before reporting.

## Authentication, authorization, sessions, and CSRF

### Rails

- Evaluate `before_action`, inherited callbacks, `only`/`except`, `skip_before_action`, concerns, mounted engines, route constraints, and direct rendering paths. A controller-wide callback may not cover a new action or inherited override.
- Verify Pundit/CanCan/custom policy checks authorize the same record and tenant used by the action. Check `policy_scope`, collection endpoints, nested resources, serializers, exports, broadcasts, and alternate lookup keys—not only show/update actions.
- Treat `authenticate_*` as identity proof only. Trace ownership and tenant checks for every `find`, `find_by`, friendly ID, global ID, attachment, and association mutation.
- For session cookies and remember-me tokens, verify secure attributes, rotation, fixation protection, logout/revocation, key separation, serializer compatibility, expiry, and secret rotation. Do not trust client-side claims merely because a cookie decrypts.
- Require verified CSRF protection for cookie-authenticated state changes, including Turbo/remote forms and JSON endpoints that accept ambient cookies. `null_session` is safe only when the action cannot fall back to session identity.

### Sinatra and Rack

- Map route order, regex/splat routes, `before` filters, mounted apps, `map` boundaries, and middleware order. Confirm authentication/authorization executes before protected route logic.
- Treat Rack::Protection as a collection of request-security mitigations, not authentication or object authorization. Verify which protections are enabled and whether proxy/origin/host configuration makes them effective.
- Review session secret strength/rotation and whether cookie contents are signed versus encrypted. Confirm privileged state is server-derived or integrity- and confidentiality-protected as required.

### Hanami

- Map routes and mounts in `config/routes.rb` to the concrete action in each app or slice, including shared base actions, imported providers, Rack middleware, and alternate API/admin slices. Confirm authentication runs before the action and authorization covers the exact record and tenant used by it.
- Treat parameter contracts, coercion, and dependency injection as input-shape controls, not identity or object authorization. Verify policy/RBAC checks receive server-derived actor context and the selected object rather than trusting `params` IDs, role names, or tenant values.
- Determine the effective session and CSRF middleware for the installed Hanami version and application configuration. Cookie-authenticated state changes need a verified token/origin control on the exact route; a POST route, valid contract, or mounted API namespace is not proof of CSRF protection.

## Strong parameters, mass assignment, and privileged-field updates

- Trace `params`, `permit`, `permit!`, `to_h`, `to_unsafe_h`, `slice`, `merge`, nested attributes, `accepts_nested_attributes_for`, serializers, service objects, and model setters into `new`, `create`, `update`, `assign_attributes`, and bulk APIs.
- Treat `require(...).permit(...)` as safe only when the exact allowlist excludes IDs, tenant/owner, role, admin, status, balance, pricing, approval, and audit fields on every create/update path.
- Flag `permit!`, `to_unsafe_h`, or later merging of raw parameters when privileged fields reach a model. Strong parameters are not authorization and do not prevent cross-tenant object selection.
- For older Rails and non-Rails ORMs, inspect `attr_accessible`/`attr_protected`, Sequel mass-assignment restrictions, virtual setters, callbacks, and nested relationship updates.
- In Hanami actions, follow `params` and validated/coerced contract output into ROM commands, repositories, entities, and service objects. Require an explicit field allowlist for privileged writes and keep actor/tenant/ownership values server-derived; a successful params contract does not authorize the mutation.

## Database and ORM review

- Active Record hash conditions and placeholder/array forms bind values. Inspect interpolated/concatenated strings passed to `where`, `having`, `joins`, `find_by_sql`, `execute`, `select_all`, `update_all`, `delete_all`, `order`, `group`, `reorder`, and raw Arel fragments.
- Dynamic identifiers, sort directions, SQL keywords, and fragments cannot be safely bound as ordinary values; use an explicit allowlist. `sanitize_sql*` is context-specific and not proof of safe query construction.
- For Sequel and adapters, distinguish expression/hash APIs and placeholders from `Sequel.lit`, interpolated dataset SQL, and raw connection execution.
- For Hanami/ROM, distinguish relation restrictions and bound commands from `Sequel.lit`, dataset escape hatches, gateway/raw SQL, interpolated fragments, and attacker-selected identifiers. Confirm repositories and relations preserve tenant restrictions on reads, aggregates, updates, deletes, and command paths.
- Verify default scopes, tenant gems, row-level security, association scopes, bulk operations, unscoped/admin paths, caches, and background jobs all preserve tenant predicates.

## Templates, HTML, and response injection

- Rails ERB output escapes by default. Trace attacker-controlled content into `raw`, `html_safe`, `safe_join`, custom `html_safe?` behavior, `content_tag` attributes, JavaScript/CSS/URL contexts, and JSON embedded into HTML.
- Review Haml/Slim escape settings, dynamic partial/template/layout names, user-authored templates, mailer templates, and custom renderers. Framework autoescaping does not make a value safe in every context.
- Sinatra template escaping depends on engine/configuration. Verify ERB/Haml/Slim settings and output helpers rather than assuming Rails behavior.
- For Hanami views, verify the actual renderer/template-engine escaping behavior and trace attacker-controlled content through raw/safe-string helpers, HTML attributes, URLs, JavaScript/CSS contexts, dynamic template names, and custom parts/renderers. Do not assume Rails `html_safe` semantics or autoescaping applies to a Hanami stack.
- Check CR/LF in response headers and cookies, unsafe download filenames, reflected exceptions, and redirects rendered into HTML/JavaScript.

## SSRF, URL handling, and redirects

- Trace input from Rails/Sinatra/Hanami parameters and contracts into Net::HTTP, URI/open-uri, Faraday, HTTParty, RestClient, HTTP.rb, webhook verification, image/document fetchers, and cloud SDK endpoint overrides.
- Parse and allowlist scheme, normalized host, and port; resolve and reject forbidden loopback/private/link-local/metadata ranges; disable redirects or revalidate every hop; and bound time, body size, and decompression. String-prefix or hostname-only checks are insufficient.
- Check non-HTTP schemes and open-uri behavior where a method also accepts local paths.
- For Rails `redirect_to`, Sinatra `redirect`, return-to parameters, OAuth callbacks, and `redirect_back` fallbacks, allowlist normalized local paths or trusted origins. Version-specific framework defaults do not replace explicit destination policy.

## Files, uploads, and archives

- Resolve paths from a trusted absolute base and enforce component-aware containment after canonicalization. Check symlinks and time-of-check/time-of-use behavior. `File.join` and `Pathname#cleanpath` alone do not enforce containment.
- Review Active Storage, Shrine, CarrierWave, Paperclip, direct uploads, importers, and custom multipart handling for streaming size limits, server-generated names, content/MIME validation, extension policy, storage outside executable/static roots, object ACLs, authorization, and safe download headers.
- Treat original filenames, content types, metadata, image dimensions, and analyzer output as untrusted. Check image/document processors for command options and resource exhaustion.
- For rubyzip, tar, and nested archives, validate every resolved entry for traversal, absolute paths, symlinks/hardlinks, duplicates, collisions, entry count, expanded bytes, compression ratio, nesting, and disk quota before extraction.
- In Hanami, include upload adapters, action body/multipart limits, configured storage providers, public/static roots, and import commands. A params contract that validates the filename or MIME string does not validate the bytes or enforce safe storage.

## Deserialization and dynamic evaluation

- Trace untrusted bytes into `Marshal.load`, `YAML.load`/unsafe Psych APIs, `Oj.load` object modes, signed/encrypted cookie serializers, caches, job arguments, GlobalID resolution, and third-party codecs.
- Prefer data-only formats and `YAML.safe_load` with the narrowest permitted classes/aliases. A gadget-chain finding requires attacker control, an effective permitted class set, and reachable dangerous behavior.
- Verify cookie/session/message signatures bind the correct purpose, expiry, tenant, and key. A valid signature from a different context must not authorize reuse.
- Trace attacker-controlled templates/expressions into `ERB.new`, Tilt engines, `eval`, `class_eval`, `instance_eval`, `send`/`public_send`, constantization, YAML tags, and dynamic job/class dispatch.

## Commands and argument injection

- Trace request/import values into backticks, `%x`, `system`, `exec`, `spawn`, `IO.popen`, Open3, shell-form process APIs, and image/document tooling.
- Prefer argument-vector forms with a fixed executable and use `--` where the target supports it. Avoiding a shell prevents shell metacharacter expansion but not option injection, attacker-selected executables, or unsafe subcommand semantics.
- Verify `Shellwords.escape` is applied to the exact value and shell; do not treat it as authorization for an attacker-selected command.

## Secrets, logging, errors, and operational surfaces

- Trace passwords, authorization headers, cookies, reset links, API keys, payment/health data, full parameters, and job payloads into Rails/Sinatra logs, exception trackers, traces, audit events, mail previews, and debug consoles.
- Verify Rails `filter_parameters` or equivalent Hanami/Rack filtering covers nested and custom credential names and applies before all logging/telemetry sinks. Filtering by a broad key name can also hide security-relevant audit context; preserve safe identifiers separately.
- Check credentials, `secret_key_base`, session secrets, database/queue credentials, OAuth secrets, and encryption keys for source control exposure, weak environment defaults, cross-environment reuse, and unsafe rotation.
- Inspect effective production exposure of detailed exceptions, web consoles, Rails info routes, letter/mail previews, Hanami development middleware, Sidekiq/admin dashboards, profiling endpoints, source maps, and development-only routes. Review Hanami settings/providers and slice-specific configuration for insecure environment defaults, permissive hosts/proxies, or secrets logged during boot.

## Jobs, channels, races, and tenant boundaries

- Make actor and tenant context explicit in Active Job, Hanami job adapters/command consumers, Sidekiq, Resque, scheduled tasks, Action Cable, retries, and dead-letter flows. Thread/fiber locals and request-scoped Hanami dependencies do not automatically provide durable job identity and must be reconstructed and cleared per unit of work.
- Re-authorize records when a job executes. GlobalID identifies a record; it does not prove the enqueuer or current tenant may still act on it.
- Verify connection pools, `CurrentAttributes`, `ActsAsTenant`, locale, time zone, and policy context are reset after each request/job to prevent cross-tenant leakage in long-lived workers.
- Check atomicity/locking for invitations, password resets, balances, quotas, inventory, approvals, one-time tokens, webhook events, and idempotency keys.

## Evidence and false-positive requirements

For every reported finding, show:

1. The concrete route/action/job and attacker-controlled value.
2. The complete data or authorization path to the affected object or sink.
3. The effective framework/gem/runtime behavior and missing mitigation.
4. The actor privileges, deployment conditions, and realistic impact.

Before confirming, verify these common non-findings:

- Active Record hash conditions/placeholders and properly bound Sequel expressions are not SQL injection.
- Ordinary escaped ERB output is not XSS; `html_safe` or `raw` is only exploitable when attacker-controlled content reaches it in a dangerous context.
- `YAML.safe_load`, a process API, HTTP client, redirect, file API, or serializer is only a candidate until unsafe input and effective options are proven.
- Strong parameters constrain fields but do not authorize the selected object or tenant.
- `authenticate_user!`, a signed ID, GlobalID, or Rack::Protection does not by itself prove object authorization.
- A Hanami params contract, ROM relation, middleware name, or apparently escaped template is not a finding or a mitigation by itself; verify the effective route, bound values, renderer, and actor/tenant enforcement.
- A model `find(params[:id])` is not reportable without showing the missing object/tenant check on the reachable action.

Pass all candidates through `false-positive-filter.md` before reporting.
