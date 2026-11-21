# Changelog

## 0.1.0 (2026-11-21)


### Features

* **api:** add redacting logs, the command entry and opt-in telemetry ([25e2cf3](https://github.com/shoutory/shoutory/commit/25e2cf354d24ca057a825879e99ef487feda7467))
* **api:** add the audit log rows, partition readiness and the owner read route ([734076c](https://github.com/shoutory/shoutory/commit/734076c773cc66e8e6e221fbdc09c9b826da27d2))
* **api:** add the HTTP skeleton with one error envelope ([8170ede](https://github.com/shoutory/shoutory/commit/8170ede43e68c8510376983759639d82fcd7f875))
* **api:** add the optional S3-compatible storage driver ([4fd10d7](https://github.com/shoutory/shoutory/commit/4fd10d77b05e4908c9d6208c662e1ff57a495736))
* **api:** add the sealed mail queue and key custody commands ([e5c840e](https://github.com/shoutory/shoutory/commit/e5c840e79441ec744197fb28b0c6e17528809d4b))
* **api:** add TOTP second factor, step-up, password reset and password policy ([0140e6f](https://github.com/shoutory/shoutory/commit/0140e6f254bbddc349a5290295d603e5e74b69b2))
* **api:** add workspace member and invitation routes ([b160a5b](https://github.com/shoutory/shoutory/commit/b160a5bcc9e57903367e4a476a00147a10609b5d))
* **api:** gate sign-up by the instance setting and add the instance admin routes ([7264391](https://github.com/shoutory/shoutory/commit/7264391b5fd4ed11cd00cb08540c756b26bd7717))
* **api:** list and create organizations and workspaces ([b81645b](https://github.com/shoutory/shoutory/commit/b81645b0c7585c69f8350aece639a1ecda26de3e))
* **api:** reach a workspace only through a minted scope ([c7d282b](https://github.com/shoutory/shoutory/commit/c7d282b7961741d265707b5806afd1a37821ea2d))
* **api:** run the job queue, outbox relay and worker role ([0c88845](https://github.com/shoutory/shoutory/commit/0c8884517becd2666573624cacc63c876ff27cfe))
* **api:** send queued mail with classes, one-click unsubscribe and a mail check ([1ca7a54](https://github.com/shoutory/shoutory/commit/1ca7a54d64c4c53ce2dcc0b39603287d8928c389))
* **api:** sign up, sign in and keep database sessions with Better-Auth ([e9e690f](https://github.com/shoutory/shoutory/commit/e9e690f31c7e2584769f12d26d0058ce9ad31895))
* **api:** store objects on the filesystem and add the storage check ([4e35061](https://github.com/shoutory/shoutory/commit/4e3506138d75b1eb120f5a03510cba956dba7c31))
* **auth:** require a code step-up for second-factor accounts ([4a74365](https://github.com/shoutory/shoutory/commit/4a74365ce36ae033369c4665c4c3cea71ed0d302))
* **core:** add the environment schema, key ring and sealed secret envelope ([fa87921](https://github.com/shoutory/shoutory/commit/fa87921498847399aac572c149c5772ed6a82b41))
* **db:** add feature flags, instance overrides and the instance admin definers ([b76ce8d](https://github.com/shoutory/shoutory/commit/b76ce8dac8931b211db257f07279607fa1755147))
* **db:** add invitations, member changes and the one-owner guard ([604e1dc](https://github.com/shoutory/shoutory/commit/604e1dccd41ff0ee8c73f7708322b40acd41d21b))
* **db:** add roles, the migration runner and the test harness ([50e6992](https://github.com/shoutory/shoutory/commit/50e6992a73bffbbf3620c2fc841e218f67efe6f9))
* **db:** add row security helpers and the tenant context ([6283367](https://github.com/shoutory/shoutory/commit/6283367e58629b9dea78813cd514f1996d3dc92b))
* **db:** add the access definers ([c71579c](https://github.com/shoutory/shoutory/commit/c71579c8188caf7fa8538a2bfdf016a37fa3d0eb))
* **db:** add the audit log, its chain head and the audit writers ([facd6e1](https://github.com/shoutory/shoutory/commit/facd6e1be744b31da265cf4254aa3dc56fe0fd9f))
* **db:** add the event outbox, retention purge and system context ([475ff93](https://github.com/shoutory/shoutory/commit/475ff938fb63a61d56fbf373c4d3a9bc21a09db9))
* **db:** add the identity, throttle and step-up data layer ([c6e5ceb](https://github.com/shoutory/shoutory/commit/c6e5ceba28d1883af1ee94d2d090396145546e12))
* **db:** add the tenancy tables, built-in roles and their row security ([d5818d6](https://github.com/shoutory/shoutory/commit/d5818d665036d05f7f30098fd6280b38b5ff864a))
* **docker:** ship the distroless image, the self-host compose file and the image smoke ([06032b0](https://github.com/shoutory/shoutory/commit/06032b0ea8cea2118bb5689cd1ffce407e44c528))
* **e2e:** prove a backup restores with a guide and a weekly drill ([d41c176](https://github.com/shoutory/shoutory/commit/d41c176626aacc4d047ab4ae9957b05587058ecf))
* **provider-sdk:** add the provider manifest, text counting and conformance kit ([7543b0b](https://github.com/shoutory/shoutory/commit/7543b0b0e7c105ecdd44a196f4f11450c0d6ab12))
* **release:** build, sign and attest multi-arch images from release tags ([fc4c91f](https://github.com/shoutory/shoutory/commit/fc4c91f3c093e8ca47252bba5e798d6074db34fb))
* serve the web app with a hashed CSP and add the web client, guard and UI kit core ([5e15e10](https://github.com/shoutory/shoutory/commit/5e15e10f1e96d9182dfde1bdc9345570858e38d4))
* **testkit:** add the simulator kit, fault matrix and fixture provider ([4b5f04a](https://github.com/shoutory/shoutory/commit/4b5f04ad90bd8cd1b6b9c36bc15f00b58b5014ce))
* **web:** add sign-up, email confirmation and password reset pages ([479933b](https://github.com/shoutory/shoutory/commit/479933b34d85d54bdc698d179c3e5fc4baa6ca5b))
* **web:** add the account security page ([964df39](https://github.com/shoutory/shoutory/commit/964df39c4b9077855b9be1bbdcdacd501814d248))
* **web:** add the admin frame, the feature flags screen and the sign-up switch ([6d541c2](https://github.com/shoutory/shoutory/commit/6d541c206c74eff011fd27efe013e073ac4af5e7))
* **web:** add the app shell with switchers, command palette and shell kit parts ([50abb8c](https://github.com/shoutory/shoutory/commit/50abb8caf0fa119c2865619b8d28060a543b8ac8))
* **web:** add the clients list, the workspace settings and the plan limits page ([2008359](https://github.com/shoutory/shoutory/commit/20083597ecaf67c7fe1bc50b7001aadd22be6f1e))
* **web:** add the first-run onboarding and the time-zone picker ([9fb78c8](https://github.com/shoutory/shoutory/commit/9fb78c8a221ca390d3683e21aaf882d4f41e0f3d))
* **web:** add the invitation page and the profile page ([df9ca54](https://github.com/shoutory/shoutory/commit/df9ca54624a31a6048ff1f82d536105f3f24f3a3))
* **web:** add the queue health, server checks and release screens for admins ([048b483](https://github.com/shoutory/shoutory/commit/048b4834e05bcba8009b15e9fdb9544a00ca720b))
* **web:** add the sign-in page, the second-factor challenge and the step-up dialog ([fdf2542](https://github.com/shoutory/shoutory/commit/fdf25425f2119e2c52c985a7031d0e5122f4f6b5))
* **web:** add the two-factor setup page ([07c1f4e](https://github.com/shoutory/shoutory/commit/07c1f4eaed723e44dcfbacddb0d31eec53604a67))
* **web:** add the web app with tokens, two languages and theme bootstrap ([9261f50](https://github.com/shoutory/shoutory/commit/9261f500d41200598f93bde597511bed3a1acbc9))
* **web:** add the workspace members page with roles, invitations and leave ([46145ac](https://github.com/shoutory/shoutory/commit/46145aca7607959ce9faf669fdf7addaf6855311))
* **web:** check every screen in a browser for UX, RTL pictures and layout shift ([f8d22f2](https://github.com/shoutory/shoutory/commit/f8d22f2b6102eaa072de946c9e5c6ef4acfec06d))


### Bug Fixes

* **api:** close the first set of milestone-close review findings ([1a80e38](https://github.com/shoutory/shoutory/commit/1a80e3865721e18afb5e6de72be7be294bde940f))
* **api:** load the template install in a clean checkout without a built dist ([a6e36de](https://github.com/shoutory/shoutory/commit/a6e36def8dbb20a9f9fb12307ef297e6affae25b))
* **e2e:** allow the breach check's lookup under the host's search domain ([c13f45a](https://github.com/shoutory/shoutory/commit/c13f45a597cf7894065cb2d72230aaf94558b621))
* **release:** keep versions below 1.0.0 until launch ([1deefaa](https://github.com/shoutory/shoutory/commit/1deefaad582540d30c185871d015b3ad9afa6c6c))
* **test:** print the global setup error instead of a source-map crash ([b1c283d](https://github.com/shoutory/shoutory/commit/b1c283d6f09c78dcc8378aec04b3f235442a6dc8))
* **web:** resolve workspace packages from source in the web test projects ([92a4547](https://github.com/shoutory/shoutory/commit/92a45475d9af0c708ac800e26faa3a6f1aeb4f84))


### Performance Improvements

* record the first idle-memory and latency baseline ([f62f1dd](https://github.com/shoutory/shoutory/commit/f62f1dd4719af89d49dc722ddc0957f894f9449b))

## Changelog
