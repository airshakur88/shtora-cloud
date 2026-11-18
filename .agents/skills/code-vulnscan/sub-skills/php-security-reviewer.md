# php-security-reviewer

Read this when a codebase contains PHP web code, Laravel, Symfony, WordPress, Drupal, Yii, a custom front controller, PHP workers/queues, Composer packages, or PHP templates.

## Goal

Find exploitable PHP web-application vulnerabilities that generic sink matching misses: route and voter/policy/access-check gaps, unsafe model/form/entity binding, framework-specific raw SQL and template escape bypasses, CMS capability mistakes, wrapper-based SSRF/file access, upload and archive handling, object injection, and tenant context loss in jobs.

## Framework and attack-surface map

Inventory the effective framework and deployment configuration before validating findings.

| Stack      | Entry-point and security signals                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Laravel    | `routes/*.php`, controllers, invokable actions, route groups, middleware, policies/gates, Form Requests, Eloquent models, jobs/listeners, Blade, Livewire, Sanctum/Passport                                                |
| Symfony    | route attributes/YAML/XML, controllers, firewalls, `access_control`, voters, authenticators, forms, serializers, Doctrine, Messenger handlers, Twig                                                                        |
| WordPress  | REST routes, AJAX hooks, admin actions, shortcodes, blocks, upload/import handlers, cron, WP-CLI, capabilities, nonces, multisite blog switching, `$wpdb`                                                                  |
| Drupal     | `*.routing.yml`, controllers/forms, route access requirements and custom access checkers, entity access handlers, REST/JSON:API, event subscribers, plug-ins, render arrays/Twig, QueueWorker/cron/Drush, `services.yml`   |
| Yii        | URL rules, controllers and standalone/inline actions, REST `ActiveController`, behaviors/filters, RBAC, models/forms/scenarios, Active Record/query builder, views, console controllers and queue jobs, application config |
| Custom PHP | front controllers, rewrite rules, session/bootstrap code, superglobals, includes, template engines, database wrappers, stream wrappers, CLI/cron consumers                                                                 |

Also inspect `composer.json`/lock, framework configuration, environment examples, web-server/FPM configuration, writable and public directories, storage adapters, queue configuration, templates, plug-ins/themes, and production debug/error settings.

Treat request data, route parameters, headers, cookies, uploaded files, database content, queue messages, cache values, webhook bodies, imported archives, and WordPress option/meta values as untrusted until their provenance and integrity are proven.

## Required review sequence

1. Enumerate HTTP, REST, AJAX, admin, webhook, console, cron, queue, import, and upload entry points.
2. Map effective authentication, authorization, CSRF, and tenant enforcement to each state-changing or data-returning path.
3. Trace untrusted values through binding, models/entities, templates, SQL, outbound requests, files, parsers, redirects, subprocesses, logs, and delayed jobs.
4. Inspect runtime configuration that changes reachability or safety, including route order, firewalls, middleware groups, PHP wrappers, WordPress constants, and public storage.
5. Report only after proving an attacker-controlled source, reachable consequence, missing/bypassed mitigation, and realistic deployment conditions.

## Authentication, authorization, and CSRF

### Laravel

- Build a route-to-middleware matrix from route files and registered middleware aliases/groups. Include resource routes, fallback routes, subdomain groups, Livewire actions, signed routes, and closures.
- Verify policies/gates receive the same tenant-scoped object used by the action. Route-model binding and `auth` prove identity, not object authorization. Check unscoped `find`, `findOrFail`, and custom binding that can cross tenants.
- Check guard mismatches across session, Sanctum, Passport, token, and admin guards. Verify middleware and policy code read the authenticated principal from the intended guard.
- Require CSRF protection on cookie-authenticated mutations. Exemptions, webhook paths, and API middleware are safe only when an equivalent signature/token control is verified on the exact route.
- Treat temporary/signed URLs as authorization only when purpose, expiry, actor/tenant, canonical URL, and one-time semantics match the protected operation.

### Symfony

- Evaluate firewall and `access_control` rules in effective order; the first matching rule matters. Include hosts, methods, path prefixes, stateless firewalls, lazy firewalls, entry points, and shared contexts.
- Verify voters or `denyAccessUnlessGranted` authorize the concrete object and tenant. `IS_AUTHENTICATED_*` alone is not object-level authorization.
- Check controller argument resolvers/entity mapping for direct unscoped object lookup. Confirm repository queries, voters, and serializer groups enforce the same organization boundary.
- Verify CSRF tokens have the expected token ID/purpose and bind to the intended action. API authentication must not silently fall back to ambient session cookies.

### WordPress

- For REST routes, require a meaningful `permission_callback`; returning `true` or checking only login status is insufficient for privileged objects or actions.
- For `wp_ajax_*`, `wp_ajax_nopriv_*`, `admin_post_*`, XML-RPC, shortcodes, and blocks, trace nonce validation, capability checks, and object ownership separately. A nonce mitigates CSRF; it is not authorization.
- Prefer capability checks such as `current_user_can()` using the relevant object ID. Verify custom roles/capabilities and multisite super-admin behavior.
- Track `switch_to_blog()`/`restore_current_blog()` and site-specific table/options access. A valid user or nonce on one site must not authorize another site.

### Drupal

- Build the route matrix from every module's `*.routing.yml`, route subscribers, REST resources, JSON:API exposure, forms, controllers, entity operations, and custom access services. Evaluate `_permission`, `_role`, `_entity_access`, `_custom_access`, HTTP method restrictions, and defaults on the effective altered route.
- Trace entity loads and queries through the entity access handler, field access, grants, and tenant/site predicates. Calls such as `accessCheck(FALSE)` and direct storage queries are candidates only when a reachable caller fails to perform an equivalent explicit check.
- Inspect custom access callbacks for the exact account and object they authorize. Verify `AccessResult` cacheability varies on all relevant user, permission, role, route, entity, and tenant contexts; an otherwise correct decision can leak when cached too broadly.
- For cookie-authenticated mutations, verify Form API token handling or an effective `_csrf_token` route requirement on the exact route. An HTTP method restriction, permission string, or authenticated session is not a CSRF defense.

### Yii

- Resolve URL rules, controller maps, modules, REST `ActiveController` defaults, custom actions, `beforeAction`, and merged `behaviors()`. Confirm `AccessControl`, authenticator filters, and RBAC checks execute for the effective action; `VerbFilter` limits methods but does not authenticate or authorize.
- Verify `Yii::$app->user->can()` is called with the rule parameters/object needed for ownership and tenant decisions. A role check or authenticated identity alone does not authorize the model selected by an attacker-controlled ID.
- Treat `enableCsrfValidation = false`, per-action CSRF bypasses, and parser/auth behavior as path-specific. Cookie-authenticated browser actions need valid CSRF enforcement; a genuinely stateless bearer-only API may use a different control only after proving ambient cookies cannot authenticate it.

## Binding and privileged-field updates

- In Laravel, trace `$request->all()`, `$request->input()`, `only`, `except`, `validated`, `Model::create`, `fill`, `update`, `forceFill`, `unguard`, casts, mutators, nested relationships, and pivot updates. `$fillable` helps only if it excludes every privileged field on the actual model and no bypass API is used.
- Treat Form Request validation as value validation, not an automatic field allowlist. Confirm `validated()` or an explicit allowlist feeds the model instead of the original request.
- In Symfony, inspect form fields, `mapped` properties, `allow_extra_fields`, DTO/entity binding, serializer groups, denormalization context, writable setters, and Doctrine cascades. Verify role, owner, tenant, status, balance, approval, and audit properties are server-controlled.
- In WordPress, trace request maps into `wp_insert_user`, `wp_update_user`, post/meta/option updates, and custom table helpers. User meta can be security-sensitive even when it does not look like a core role field.
- In Drupal, follow Form API submitted values, REST/JSON:API normalization, entity forms, `Entity::create`, `set`, and storage saves into entity fields and configuration. Validation and field editability are separate from entity/field access; confirm privileged fields and referenced entities are server-controlled.
- In Yii, follow request bodies through `Model::load()`, `setAttributes()`, REST serializers/actions, form models, active scenarios, and `rules()` marked `safe`/`unsafe`. `load()` limits assignment to attributes safe in the active scenario, but a broad or attacker-selectable scenario can still expose role, owner, tenant, status, or pricing fields; validation is not object authorization.

## Database and ORM review

- Treat PDO or mysqli prepared statements as safe for values only when the query structure stays fixed and parameters are actually bound. Concatenation before `prepare()` remains injectable.
- For Eloquent/query builder, inspect `whereRaw`, `selectRaw`, `orderByRaw`, `groupByRaw`, `havingRaw`, `DB::raw`, `DB::unprepared`, raw expressions, user-selected column/direction names, and tenant scopes. Normal builder value arguments are parameterized; their mere presence is not a finding.
- For Doctrine, inspect DQL/native SQL, `createQuery`, `createNativeQuery`, `addOrderBy`, expression fragments, table/column identifiers, and parameter binding. QueryBuilder is not proof that raw fragments are safe.
- For WordPress, verify dynamic SQL passes through `$wpdb->prepare()` with placeholders and that table/column/order fragments come from a strict allowlist. Escaping functions for HTML or SQL strings are not substitutes for query parameterization.
- For Drupal, distinguish Database API conditions/placeholders and entity-query conditions from raw fragments passed to `Connection::query`, `where`, `addExpression`, joins, or dynamic table/field/order inputs. Also verify entity queries and storage bypasses preserve access grants and tenant predicates.
- For Yii Active Record/query builder, hash conditions and properly bound parameters are not injection. Trace interpolation and untrusted fragments into string conditions, `yii\\db\\Expression`, `createCommand()`, raw SQL, `orderBy`/`groupBy`, table names, and column names, and verify default scopes are not bypassed on alternate/admin paths.
- Check bulk update/delete, soft-delete restoration, relation traversal, cache keys, global scopes/filters, jobs, and admin exports for missing tenant predicates.

## Templates, HTML, and response injection

- Blade `{{ ... }}` escapes HTML by default; `{!! ... !!}`, raw PHP output, dynamic components/attributes, JavaScript/URL/CSS contexts, and stored rich text require separate validation and context-aware encoding.
- Twig autoescape is context dependent. Trace `|raw`, `autoescape false`, sandbox configuration, dynamic template names, `createTemplate`, and untrusted template sources. Do not report normal escaped `{{ value }}` output.
- In WordPress, choose the output-context function (`esc_html`, `esc_attr`, `esc_url`, `wp_kses`, safe JSON/script encoding). Sanitization on input does not replace encoding at the final output context.
- In Drupal, normally autoescaped Twig output and render-array plain text are not XSS. Trace untrusted content into `#markup`, `Markup::create`, Twig `|raw`, unsafe render callbacks, attributes, URLs, JavaScript/CSS contexts, and cached render output; verify cache contexts prevent one user's sensitive fragment reaching another.
- Yii PHP views do not make every `echo` safe. Require output-context encoding such as `Html::encode()` for text/attributes and a reviewed rich-text policy; trace untrusted values into raw PHP output, widgets, client-script registration, URLs, JavaScript/JSON, and custom view renderers.
- Review CR/LF in custom headers and cookies, unsafe `Content-Disposition` filenames, reflected exception messages, and JSON embedded into HTML.

## SSRF, URLs, and redirects

- Trace input to Laravel's HTTP client, Drupal's `http_client`/Guzzle service, Yii HTTP clients, Symfony HttpClient, cURL, `file_get_contents`, `fopen`, WordPress HTTP APIs, image/document importers, webhooks, and redirect-following clients.
- Parse and allowlist scheme, normalized host, and port; resolve and reject forbidden loopback/private/link-local/metadata destinations; disable redirects or revalidate every hop; and limit response size/time/decompression. Blocking a string such as `localhost` is not sufficient.
- Account for PHP stream wrappers (`file`, `php`, `data`, `phar`, `zip`, `glob`) where a function accepts both URLs and paths.
- For `redirect()`, Drupal/Yii response redirects, `RedirectResponse`, `wp_redirect`, `header('Location: ...')`, and return-to parameters, allowlist normalized local destinations or trusted origins. `wp_safe_redirect` is useful only with correct allowed-host policy and fallback handling.

## Files, uploads, and archives

- Resolve paths against an absolute trusted base, canonicalize, and enforce component-aware containment. Check symlinks and time-of-check/time-of-use behavior. `basename()` alone may not make an unsafe include or overwrite acceptable.
- For Laravel/Symfony uploads and WordPress media/import flows, verify streamed size limits, server-generated names, MIME/content checks, extension policy, storage outside executable/public roots, authorization, image/document parser risks, and safe download headers.
- In Drupal, distinguish `public://`, `private://`, and `temporary://` stream wrappers; verify managed-file usage/access, upload validators, URI-scheme allowlists, and the effective web-server policy. In Yii, review `UploadedFile`, aliases such as `@webroot`, storage components, and download actions instead of trusting the original name, extension, or MIME header.
- Treat the client filename, extension, MIME header, and image metadata as untrusted. Verify web-server mappings cannot execute an uploaded file and that public object-store ACLs are intentional.
- For ZIP/TAR/PHAR and nested archives, validate each resolved entry for traversal, absolute paths, symlinks/hardlinks, duplicates, collisions, entry count, expanded size, compression ratio, and disk quota before extraction.

## Deserialization, XML, and template/code evaluation

- Trace untrusted bytes into `unserialize`, `maybe_unserialize`, PHAR metadata access, Symfony/Laravel serialization, session/cache serializers, and third-party decoders. `allowed_classes => false` reduces PHP object creation but still requires data-shape and resource limits.
- Treat a gadget-chain claim as dependency- and reachability-dependent; prove attacker control reaches deserialization and that the effective class set or magic methods can cause impact.
- For XML, verify the actual PHP/libxml version and parser flags. Flag external entity expansion only when configuration such as `LIBXML_NOENT`, DTD loading, or a custom entity loader makes it reachable; parser presence alone is not XXE.
- Trace user-authored templates or expressions into Blade compilation, Twig `createTemplate`, `eval`, `assert` on legacy runtimes, callback selection, dynamic class construction, and plug-in/theme editors.

## Commands and dynamic invocation

- Trace request/import values into `system`, `exec`, `shell_exec`, `passthru`, `popen`, backticks, Symfony `Process::fromShellCommandline`, and Laravel process shell strings.
- Prefer argument-vector process APIs with a fixed executable. `escapeshellarg()` protects one shell argument but does not prevent option injection or unsafe semantics in the invoked program.
- Review dynamic callbacks (`call_user_func*`), reflection, autoload/include paths, Composer scripts, WordPress hooks, and class/method names when attackers influence the callable.

## Secrets, logging, errors, and debug surfaces

- Trace authorization headers, cookies, passwords, reset links, API keys, payment/health data, full request bodies, and uploaded content into framework logs, WordPress debug logs, traces, error pages, and audit records. Parameterized/structured logging does not make sensitive values safe.
- Verify Laravel/Symfony secret and key management, WordPress salts/keys, Drupal hash salt/private keys, Yii `cookieValidationKey`, database credentials, queue credentials, OAuth secrets, and encryption keys are not committed, exposed in diagnostics, or reused across environments.
- Check effective production settings for debug toolbars, detailed exception pages, profiler routes, `APP_DEBUG`, Symfony dev routes, `WP_DEBUG_DISPLAY`, Drupal development services/Twig debug and trusted-host/reverse-proxy settings, Yii debug/Gii exposure, `display_errors`, phpinfo, Telescope/Horizon, and administrative maintenance tools.

## Queues, races, and tenant boundaries

- Make tenant/actor context explicit in Laravel jobs, Symfony Messenger envelopes, WordPress cron, Drupal QueueWorker/cron/batch/Drush work, Yii queue/console work, retries, and dead-letter handling. Never infer authorization from an attacker-editable tenant ID inside a payload.
- Re-authorize referenced objects when delayed work executes; verify jobs cannot act on an object moved to another tenant or revoked after enqueue.
- Clear long-lived worker state between jobs, including container singletons, database connections/scopes, locale, authenticated user, and current WordPress blog.
- Check atomic consumption and locking for reset tokens, invitations, balances, quotas, inventory, approvals, idempotency keys, and webhook events.

## Evidence and false-positive requirements

For every reported finding, show:

1. The concrete route/hook/job and attacker-controlled value.
2. The complete data or authorization path to the affected object or sink.
3. The effective framework/runtime configuration and missing mitigation.
4. The deployment conditions, actor privileges, and realistic impact.

Before confirming, verify these common non-findings:

- Normal Eloquent/Doctrine builder values, PDO bound parameters, and `$wpdb->prepare()` placeholders are not SQL injection.
- Blade `{{ value }}`, normally autoescaped Twig output, and correctly contextual WordPress escaping are not XSS.
- A process, HTTP client, XML parser, archive library, raw-output helper, or deserializer is only a candidate until attacker-controlled reachability and unsafe configuration are shown.
- Laravel validation and Symfony forms prevent mass assignment only when the resulting allowlisted data—not the original request—is used for the update.
- WordPress nonces are CSRF controls, not capability or object-authorization checks.
- Drupal route permissions, entity query access, and render caching must be evaluated together; `accessCheck(FALSE)` or `#markup` alone is only a candidate until a reachable authorization or output-encoding failure is shown.
- Yii `Model::load()` respects active-scenario safe attributes, and query-builder bound values are not SQL injection; confirm the effective scenario or raw fragment before reporting.
- An authenticated route and a model lookup do not prove object or tenant authorization.

Pass all candidates through `false-positive-filter.md` before reporting.
