# Documentation maintenance

WearMux Headless keeps its project overview in the [README](../README.md), operational details in the [technical guide](technical-guide.md), and integration contracts in source JSDoc comments. The generated HTML site combines those guides with the class and function reference. Generated HTML is a build output and is not committed.

## Build and preview locally

From the repository root, install dependencies and generate the site:

```bash
npm ci
npm run docs
```

Open `docs/api/html/index.html` in a browser. The site is static and also works through any local static-file server. Node.js is the only runtime used by the documentation generator; it does not connect to hardware, run FFmpeg, or start Python sidecars.

On a machine used solely for documentation, `npm ci --ignore-scripts` avoids native addon installation scripts. That installation is suitable for documentation, but is not a replacement for the normal runtime dependency installation.

`npm run docs:check` generates the same site and checks JSDoc parsing, expected core class coverage, documentation of public methods, explicit JSDoc links, and local generated file links and section anchors. Both documentation commands fail on JSDoc warnings. This checks the reference structure; maintainers still need to verify descriptions against behavior and hardware.

## GitHub Actions and Pages

The [documentation workflow](../.github/workflows/documentation.yml) generates and checks the site on relevant branch pushes and pull requests, and can be started through **Actions → Documentation → Run workflow**. Each build uploads a `wearmux-headless-docs-<commit>` artifact containing the static site. No wearable hardware, deployment token, or additional repository secret is required.

Only `main` publishes the public site. For the public GitHub mirror, enable Pages once in **Settings → Pages → Build and deployment → Source → GitHub Actions**. After these files reach `main`, a matching push publishes the site; if the files were mirrored before Pages was enabled, run the Documentation workflow manually with the branch set to `main`.

The expected site address is [nap-it.github.io/wearmux-headless](https://nap-it.github.io/wearmux-headless/). It becomes available after the first successful Pages deployment. GitLab mirrors source and workflows to GitHub; generated HTML is built by GitHub Actions, rather than copied through the mirror. If a mirror update does not start Actions, use the manual workflow button.

Branch and pull-request builds produce downloadable artifacts without replacing the public site. The public reference follows `main` and is not a versioned release archive. Link to a repository tag when documenting an older release.

This branch includes the Android BLE adapter, protocol, and Droidspaces guides in its generated artifact. Repository links use the local branch or exact detached CI commit rather than always pointing to `main`. Set `DOCUMENTATION_REF` when generating from a source archive without Git metadata, or when intentionally targeting a tag.

## Update the reference

- Keep setup and user-facing instructions in the README, technical guide, or focused module guides.
- Document constructors, parameters, return values, units, events, ownership, and error behavior beside the relevant exported classes/functions. Mark implementation helpers `@private`.
- Maintain shared payload and transport typedefs in `docs/api/types.js`. These describe interfaces; they do not implement runtime validation.
- Update [developer integration](api/integration.md) and [message contracts](api/message-contract.md) when changing connection ownership, routing, framing, or time bases.
- Add intentional reference entry points to `jsdoc.json`. Third-party code, models, private helpers, and examples are excluded from the code reference.
- Run `npm run docs:check` and inspect the affected HTML pages before committing documentation changes. Behavior changes also require the repository's relevant tests.

`tools/build-docs.js` converts links in the existing Markdown guides into site tutorial links and copies the paper figures. Other source links point to their locations in the GitHub repository. This keeps Markdown usable both on GitHub and in the generated site, without maintaining duplicate guide content.
