# Phase 0: verified setup facts and open checks

Checked on 2026-10-07 before implementation.

## Confirmed from primary sources

- Meta's Threads collection documents image containers that fetch an image from a public URL, the separate `threads_publish` request, and carousel child/parent containers. Its container-status request specifies GET `/{container-id}?fields=id,status,error_message`. Reconciliation now uses that read-only route and marks a result published only when the returned ID is the saved container ID and status is exactly `PUBLISHED`; the collection's prose mentioning `threads_publish` is not used for status checks.
- Meta's Instagram Login collection is intended for professional (Business or Creator) accounts and lists `instagram_business_content_publish`. The collection page was only partially accessible during this check. Endpoint details, permissions, media constraints, and status behavior still need an account-backed confirmation.
- GitHub Contents API requires the blob `sha` when updating an existing file. The state adapter uses that SHA and checks for conflicts.
- The GitHub REST API supports the `2026-03-10` version and specifies it through `X-GitHub-Api-Version`; the client pins that version.
- With that API version, workflow dispatch can return the created workflow run's `html_url`; the CLI uses that exact URL. When GitHub returns the legacy body-less `204`, it falls back to the workflow runs page instead of guessing among concurrent runs.
- GitHub Pages can deploy a custom workflow artifact with `upload-pages-artifact` and `deploy-pages`; this is the selected automatic image hosting adapter. A commit made with `GITHUB_TOKEN` alone does not start a Pages build, so the workflow uses the Pages deployment actions.
- The publish workflow checks that the selected source SHA matches its checkout and is still the default branch tip immediately before invoking the publisher. If a newer push arrived while a run waited, that stale snapshot stops before SNS calls.
- GitHub Free supports Pages for public repositories. Pages output is publicly accessible even if the source repository is private on a plan that permits private Pages. The project therefore publishes images only and warns that image URLs are public before the scheduled post time.

## Not confirmed; no credentials or destination account were supplied

- Instagram account type, Meta app mode/review/access level, permissions, API version, token scope/expiry, image and caption limits, carousel limits, and container lifetime.
- Threads account authorization, API version, token scope/expiry, current image/caption limits, and whether the documented container status route returns `PUBLISHED` for a published container on the configured account/version. The request fields and GET method are documented, but real response behavior is not account-verified.
- Whether Instagram's configured API version returns same-container `PUBLISHED` in its existing read-only container status GET. The adapter requires an exact same-ID `PUBLISHED` response; all other responses remain unknown.
- Account-backed publishing-quota responses for the selected Instagram/Threads versions. On 2026-10-09 the adapters added GET `/{account-id}/content_publishing_limit` (Instagram) and `/{account-id}/threads_publishing_limit` (Threads), requesting `quota_usage,config`. The quota reader requires one data record with non-negative integer usage/total and a positive integer duration. Threads' route and fields were checked against Meta's official collection; Instagram's reference could not be fetched during this session (HTTP 429), and the configured-version response contracts for both services still need live confirmation. Local mocked tests validate deferral, response failures, saved-container retention and no publication when quota is unverified. Any publish-stage 429 remains outcome-unknown.
- The live repository owner/name, default branch, `publisher-state` branch, branch rules, GitHub plan, Pages configuration, Pages URL, and whether the target repository can be public.
- Any actual image URL, public GET response, or deployed Pages artifact.

No SNS credentials were present or used. No remote repository, workflow run, Pages deployment, or SNS post was created. These unresolved items are deployment prerequisites; the implementation keeps API versions explicit and refuses unsafe automatic retries.

## Sources

- [Meta Instagram Login collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)
- [Meta Threads authorization collection](https://www.postman.com/meta/threads/folder/34203612-e0373e84-de6b-46f1-b90d-3fea76ba6782)
- [Meta Threads API collection](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api)
- [Meta Threads container status request](https://www.postman.com/meta/threads/request/ohuldvi/check-container-s-publishing-status)
- [Meta Threads quota request](https://www.postman.com/meta/threads/request/7evieur/retrieve-publishing-quota-limit)
- [Instagram publishing quota reference; retrieval was rate-limited on 2026-10-09](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit/)
- [ICC.1:2022 profile specification (mluc string records are UTF-16BE)](https://www.color.org/ICC1-V41.pdf)
- [ITU-T T.81 JPEG specification](https://www.w3.org/Graphics/JPEG/itu-t81.pdf)
- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)
- [GitHub REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- [GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub Pages eligibility and visibility](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [GitHub Actions concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)
