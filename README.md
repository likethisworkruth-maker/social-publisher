# social-publisher

完成した画像付き投稿をInstagramとThreadsへ届ける、Node.js / TypeScript製の小さな運用ツールです。実際のSNS投稿はすべてGitHub Actionsで行い、PC上の `npm run publish` はそのworkflowを起動します。ローカルからSNS APIを直接呼ぶ投稿経路はありません。

本番認証・実アカウント・画像配信先をまだ設定していない状態でも、入力検証、Dry Run、モックテスト、workflow、状態保存の実装は利用できます。実SNS接続は、Phase 0の確認事項を解消するまで実行しないでください。

## 動作環境と初期設定

- Node.js 22.17以降
- GitHubリポジトリとGitHub Actions
- Instagram Loginを使うBusiness / Creatorアカウント
- Threadsアカウント
- GitHub Contents APIへ書き込めるActions token
- 公開HTTPSで画像を配信できる場所

### GitHubアカウントを用意する前のローカル確認

画像投稿を初期対象としています。動画投稿はまだ実装していません。

```powershell
npm ci
npm run typecheck
npm test
npm run demo
npm run sample
npm run validate
npm run preview
```

`demo` は同梱JPEGと模擬SNSを使い、Instagram成功・Threads準備失敗、Threadsだけの再試行、再実行時の二重投稿防止を確認します。ネットワーク接続、GitHub認証、本番状態保存、実SNS投稿は行いません。

`sample` は `posts/sample-post/` に編集用JSONと1080×1080のsRGB JPEGを作成します。別のIDには `npm run sample -- --id my-first-post` を使えます。サンプルは `enabled: false` で、既存フォルダへの上書きはしません。画像・本文・日時を差し替え、検証後に `enabled: true` に変更します。`examples/` は投稿対象ではありません。

`preview` は常にローカルDry Runです。Windows PowerShellでは、引数付きのコマンドには `npm.cmd` を使ってください（例：`npm.cmd run publish -- --dry-run --id sample-post`）。`npm.ps1` に `--dry-run` がnpm設定として消費された場合も、本ツールはその意図を優先してローカルプレビューに留めます。

Windowsの制限された実行環境でも動くように、テストはNodeの同一プロセスモードを使います。テストのHTTP応答はモックであり、実SNS投稿の成功を意味しません。

新しい専用GitHubアカウントへの接続手順は [初回セットアップ](docs/setup.md) にあります。ローカル確認中は既存のGitHubログインやGit設定を変更する必要がありません。

最初のpush前にPCでGitHub CLIへサインインし、依存関係を入れて状態ブランチを初期化します。状態ブランチは、投稿入力から独立した空の履歴として作成します。

```powershell
gh auth login
npm ci
npm run state:init
```

`state:init` は、リモートリポジトリに `publisher-state` がない場合だけ、`store.json` を含むorphanブランチを作成します。既存ブランチを初期化し直したり、状態を消したりしません。Fine-grained GitHub tokenを使う場合は、対象リポジトリのContents: writeを付けてください。

その後、リポジトリを既定ブランチへpushしてActionsを有効にします。GitHub Pagesを使う場合はSettings → Pages → Build and deployment のSourceを **GitHub Actions** にしてください。最初のpushで `prepare-assets.yml` が画像だけのPages成果物を公開します。投稿JSON・本文・予定日時はPages成果物へ含めません。

GitHub Settings → Secrets and variables → Actions で、次のSecretsを登録します。

| Secret | 用途 |
| --- | --- |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram Loginで認可したユーザーtoken |
| `INSTAGRAM_ACCOUNT_ID` | 対象Instagramプロアカウント |
| `THREADS_ACCESS_TOKEN` | Threads用の独立したユーザーtoken |
| `THREADS_USER_ID` | 対象Threadsユーザー |

次のVariablesも登録します。APIバージョンは必須で、既定値を暗黙に選びません。対象アカウントとMeta App Dashboardで接続確認した版を `vNN.N` 形式で設定してください。

| Variable | 用途 |
| --- | --- |
| `INSTAGRAM_API_VERSION` | 確認済みのInstagram API version |
| `THREADS_API_VERSION` | 確認済みのThreads API version |
| `INSTAGRAM_TOKEN_EXPIRES_AT` | Instagram tokenの失効日時。ISO 8601 |
| `THREADS_TOKEN_EXPIRES_AT` | Threads tokenの失効日時。ISO 8601 |
| `MAX_LATENESS_MINUTES` | 自動公開を許す遅延。既定値は1440分 |
| `MAX_POSTS_PER_RUN` | 1回の実行で新しく処理する予約投稿数。既定値は10、設定範囲は1〜100 |
| `ASSET_MODE` | `pages` または `fixed-url`。既定値は `pages` |
| `ASSET_BASE_URL` | `fixed-url` の場合に限り、画像ホストの公開ベースURL |

token期限のVariablesがない、期限切れ、7日以内の場合はActions Summaryに確認メッセージを出します。期限切れmetadataが設定されている場合、新しい公開処理を止めます。実際のtoken期限・scopeはMetaのtoken debuggerと運用者の記録でも確認してください。

ローカルのworkflow起動にはGitHub CLIの認証を使います。Fine-grained tokenでdispatchする場合、Contents: writeとActions: writeが必要です。認証情報は投稿JSONや状態ブランチへ置かないでください。

## 投稿を追加する

投稿ごとに `posts/<id>/post.json` と1〜10枚のJPEG画像を置き、既定ブランチへcommit / pushします。

```text
posts/
└── 2026-10-10-child-development/
    ├── post.json
    ├── 01.jpg
    ├── 02.jpg
    └── 03.jpg
```

```json
{
  "schemaVersion": 1,
  "id": "2026-10-10-child-development",
  "enabled": true,
  "publishAt": "2026-10-10T20:00:00+09:00",
  "text": "共通本文",
  "images": ["01.jpg", "02.jpg", "03.jpg"],
  "platforms": ["instagram", "threads"],
  "overrides": {
    "instagram": { "text": "Instagram用の説明文" },
    "threads": { "text": "Threads用の短い本文" }
  }
}
```

`status` は入力に書きません。実行状態は `publisher-state` ブランチだけに保存します。`enabled` は省略時trueです。SNS別本文は `overrides[platform].text` があればそちらを使います。空の上書きはエラーです。

入力制限は、Instagram本文2,000、Threads本文500 UTF-16コード単位、JPEG / sRGB ICC profile / 1080×1080 / 5,000,000 bytes以下です。画像のファイル名は投稿フォルダ直下の `.jpg` / `.jpeg` に限ります。画像の変換や本文の切り詰めはしません。これらはツール側の範囲であり、Metaの現行上限を保証しません。実API版で利用可能な値は実投稿前に確認してください。

`npm run validate` はローカルのJSONと画像を検証します。公開状態・SNS API・画像ホストには接続しません。変更前に `npm run test` と `npm run typecheck` を実行してください。

## Dry Runと公開

`npm run publish -- --dry-run` はローカル入力のプレビューです。本文長はJavaScriptのUTF-16コード単位で表示し、画像本文も画面に出します。GitHub認証・保存済みpublisher-state・SNS API・画像アップロード・状態更新は参照せず、ローカル入力に基づいて公開準備または日時待ちを表示します。保存済み状態を読むDry RunはActions画面の `Publish and reconcile` workflowを `action=dry-run` で起動します。このDry Runは状態に応じて公開準備、準備再開、公開、再試行待ち時刻、attempt上限、遅延超過、無効化、run上限、公開結果照合のみを表示します。編集可能な準備前の内容は `would_prepare`、準備開始後に固定された内容の変更は `content_changed` と表示します。いずれのDry RunもSNS APIや画像アップロード、状態更新は行わず、公開済み状態も未確認と明示します。指定IDだけを見る場合は `--id <id>` を付けます。

`npm run publish` はGitHub Actionsへ期限到来分の処理を依頼します。`--id <id>` を付けると対象を限定します。CLIは未commit変更、既定ブランチ以外、pushされていないcommit、originとrepositoryの不一致を検出して停止します。送信したsource commitをworkflowのcheckoutと実行に固定し、公開直前にそのcheckoutが既定ブランチの最新commitか再確認します。待機中に新しいpushがあったrunは公開せず終了し、後続runが新しい内容を処理します。CLIはdispatch APIが返す個別run URLを表示し、古いAPI応答のように本文がない場合だけworkflow実行一覧へ案内します。dispatch応答は[GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)に従います。workflowの起動は投稿成功を意味しません。返されたActions runとSNS別結果を確認してください。

実行一覧へ直接移動するURLの形式は `https://github.com/OWNER/REPOSITORY/actions/workflows/publish.yml` です。

`publishAt` は指定時刻より前に公開処理を始めないための時刻です。20分ごとのActions実行により、通常は約30分以内の開始を目標にしますが、GitHubの遅延・欠落は保証されません。24時間を超えた新しい公開処理は既定で止まり、明示したIDに対する一回だけの `--now` で遅延と未来日時の制限を解除できます。

```powershell
npm run publish -- --id 2026-10-10-child-development --now
```

`--now` でも `enabled: false`、入力不正、内容変更、公開済みSNS、結果不明を無視できません。成功SNSの再送も行いません。

GitHub Actions UIからの手動実行は初期値がDry Runです。投稿する場合はActionを明示的に `publish` へ変えてください。定期実行は `publish` を選びます。状態更新を行うworkflowはすべて同じ `social-publisher-production` concurrency groupで直列化され、`cancel-in-progress: false` です。

## 画像公開

既定の `ASSET_MODE=pages` はGitHub Pagesを使います。既定ブランチからのpushで起動した全jobが同じ `github.sha` をcheckoutし、画像を内容SHA-256ごとのURLへコピーします。Pages artifactを `upload-pages-artifact` / `deploy-pages` で公開し、同じsource commitの入力と一致したマニフェストだけを状態ブランチへ保存します。投稿実行時にもマニフェストと配信画像を再検証します。

公開画像は投稿予約日時より前に、認証不要のURLでインターネットから閲覧できます。画像パスは `<post-id>/<image-sha256>/<filename>` で、別の内容の画像URLを上書きしません。以前の画像マニフェストも状態ブランチへ残し、次のPages成果物へ過去の画像を取り込むため、投稿入力の削除や画像差し替えで既公開URLが消えません。画像履歴を自動削除しないため、Pagesの1 GB上限に近づいたら過去の公開投稿を確認してから運用者が整理してください。投稿本文やtokenはPagesへ載せません。Pages出力自体は公開サイトです。

既存ホストを使う場合はRepository Variableを `ASSET_MODE=fixed-url` とし、`ASSET_BASE_URL` にHTTPS base URLを設定します。各ファイルを次の規約で先に公開してください。

```text
<ASSET_BASE_URL>/<post-id>/<image-sha256>/<filename>
```

`npm run validate` の出力に投稿ID、input hash、各画像のhashが表示されます。その値を使ってホストへ画像を置きます。SNS投稿の前に実際のURLからGETし、画像バイトが元画像と一致しなければ公開しません。固定URL方式ではPages deploymentは行いません。

GitHub PagesはGitHub Freeでは公開リポジトリで利用できます。プランによって非公開リポジトリでの利用も可能ですが、Pagesサイトは公開範囲がpublicです。Pagesの公開サイトは1 GB、帯域は月100 GBのsoft limitなどがあり、用途・規約・契約条件を確認してください。画像を公開できない場合は、適切な有料ホストまたは既存サイトを選んでください。

## 状態と障害対応

`publisher-state` ブランチは投稿ID、SNS別状態、コンテナcheckpoint、公開ID、画像マニフェストを保持します。既定ブランチの入力とは分離し、GitHub Contents APIのblob SHAで競合を検出します。登録済みIDの状態ファイル欠落、branch欠落、破損、更新失敗では公開要求を止めます。投稿IDを使い回すために状態ブランチを消したり、過去commitへ戻したりしないでください。

SNS別状態は `pending` → `preparing` → `ready` → `publish_requested` → `published` と進みます。初回のSNSコンテナ準備を始める直前に状態checkpointを保存し、その時点から本文・画像・対象SNS・アカウントをcontentHashで固定します。画像manifestの配信待ちや一時404・通信失敗ではAPIを呼ばず、次回確認時刻を保存して再確認します。この待機中にコンテナ準備が始まっていなければ同じIDの入力を更新できます。公開要求の直前にcheckpointを保存・読み直し確認し、成功応答は次のSNSへ進む前に保存します。準備中のコンテナIDは次回へ引き継ぎます。安全に未公開が確認できた準備失敗だけを最大5回まで延期再試行します。

Instagramの `content_publishing_limit` とThreadsの `threads_publishing_limit` にGETし、応答の `quota_usage` と `config.quota_total` を比較します。新しいコンテナ準備前と公開要求直前に照会し、上限の固定数値は使いません。枠不足、通信障害、429/5xx、欠落・不正な応答は公開せず20分以上待って再確認します。Retry-Afterがあれば最大24時間まで待ち時間を延ばします。枠の回復時刻は推測しません。権限などの確定した4xxエラーは `failed` として設定修正後の明示再開が必要です。枠待ちは準備試行回数を消費せず、準備済みコンテナも保持します。照会後に別ツール等が枠を使う可能性があるため、公開要求後の429などは従来どおり結果不明です。各APIバージョン・アカウントでの実応答は接続時に確認してください。

公開要求のタイムアウト、run停止、HTTP 5xx、応答解析失敗、公開後の状態保存失敗は結果不明として扱います。状態は `unknown` / `publish_requested` に残り、SNSへの公開要求を自動でやり直しません。GitHub・Meta・画像のHTTP要求には30秒のtimeoutを設けています。`npm run reconcile -- --id <id>` は読み取り専用の照合workflowを起動します。保存済みコンテナIDと同じAPI versionで、そのコンテナのGET状態がID一致かつ `PUBLISHED` のときだけ `confirmedBy=verified_container_status` として公開済みに更新します。Threadsは公式collectionのGET `/{container-id}?fields=id,status,error_message` を使います。404、`FINISHED`、その他の値、timeout、API version不一致では `unknown` のままです。公開用 `threads_publish` を照合に使いません。実アカウント・設定API versionでの応答は未確認です。

運用者が対象アカウントを確認し、公開されていない根拠を記録してから再開するときは、次の明示的な復旧操作を使います。成功済み投稿を巻き戻す操作はありません。

```powershell
npm run recover -- --id 2026-10-10-child-development --platform threads --confirm-not-published --evidence "2026-10-11T03:00Z: 対象アカウントの投稿一覧を確認し該当投稿なし"
```

`retry-failed` コマンドは重複しないことを確認した上で、publish要求前の確定した `failed` だけを明示的に再開します。試行回数の上限に達していても再開でき、監査履歴に再開前の回数を残します。`unknown` と `publish_requested` はこの経路で解除できません。`recover` も確認済みの未公開結果に対して次の準備回数をリセットし、以前の準備開始時刻と復旧履歴による本文・画像・対象SNS・アカウントの固定は保ちます。

```powershell
npm run retry-failed -- --id 2026-10-10-child-development --platform threads --confirm-not-published --evidence "2026-10-11T03:00Z: コンテナ作成が公開要求前に失敗したことを確認"
```

本文・画像順・対象SNS・アカウントを最初のコンテナ準備checkpoint後に変えるとcontentHash不一致で自動続行を止めます。Pages配信待ちなど、SNS準備が始まる前なら同じIDの入力更新を許可します。準備開始後に変更する修正版には新しいIDを使います。`publishAt` と `enabled` はhashから除外されます。`enabled: false` や入力フォルダ削除は新しい公開を止めますが、保存済み履歴と結果不明の照合対象を削除しません。

`unknown` または `publish_requested` の再開には、対象SNSで未公開であることを人が確認し、復旧Evidenceを記録する必要があります。入力・権限・画像エラーの修正はエラー状態を自動解除しません。SNSの公開結果を確認できないままの再送は行わないでください。

Actions Summaryでは投稿ID、SNS、状態、UTC/JSTログを表示します。本文全文・token・Authorization header・API request URL・provider error bodyは通常ログへ出しません。失敗通知はGitHub Actionsの通知とSummaryを使います。

## 無料条件と運用費

費用ゼロは保証しません。GitHub FreeではGitHub Pagesを使うには公開repositoryが必要で、サイト内容は公開されます。Private repositoryでは契約のPages利用条件とActions使用枠を確認してください。Pagesの配信量、Actions分数、既存ホストの保管・転送費用も考慮します。

20分間隔のscheduleは30日で約2,160回起動します。平均1分のrunなら約2,160 runner分に、asset push・手動実行・testsが加わります。公開repositoryではActions標準runnerに無料利用条件があります。Private repositoryはアカウントの付与枠を超えると課金対象になり得ます。GitHub Pagesも1 GB site、月100 GBのsoft bandwidth limit等があります。最新のプランと請求条件は公式資料を確認してください。

公開repositoryでは、投稿本文・日時もpush時点でGitHub上から読めます。本文を隠す場合はPrivate repositoryを選び、公開画像だけ別のhostへ出してください。GitHubの公開Pages URLは投稿前から閲覧可能です。定期workflowが60日間活動のない公開repositoryで無効になる場合があるため、Actions画面でscheduleの最終実行日時も確認してください。

## Phase 0: 実アカウントで確認する項目

`docs/phase-0-verification.md` に、公式資料で確認できた仕様と未確認条件を記録しています。実投稿の前に、運用者がMeta App Dashboardと対象アカウントで以下を埋めてください。

- Instagram Login、Business / Creator種別、App mode、アカウントrole、permission / access level、token期限。
- Threads App認可、Threads token、target user ID、scopeと期限。
- Instagram / ThreadsそれぞれのAPI version、画像・本文・カルーセル制限、container期限、status照合能力、公開quota照会の可否。
- GitHub repository visibility、Actions分数、Pages source/URL、publisher-state branch rule。
- GitHub Pagesまたは固定hostからの匿名GET結果と画像hash一致。

InstagramとThreadsのtokenは別々に設定します。API versionはコードの既定値を使わず、実アカウントで接続試験してから登録してください。未確認の条件は安全だと推測して埋めず、そのまま未確認として扱います。

## 公式資料

- [Meta Instagram Login collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)
- [Meta Threads authorization collection](https://www.postman.com/meta/threads/folder/34203612-e0373e84-de6b-46f1-b90d-3fea76ba6782)
- [Meta Threads API collection](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api)
- [Meta Threads container status request](https://www.postman.com/meta/threads/request/ohuldvi/check-container-s-publishing-status)
- [Meta Threads publishing quota request](https://www.postman.com/meta/threads/request/7evieur/retrieve-publishing-quota-limit)
- [Instagram publishing quota reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit/)
- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)
- [GitHub REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- [GitHub Actions workflow syntax and concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub Pages eligibility and visibility](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [GitHub Pages usage limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub workflow inactivity behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)

## Commands

```text
npm run validate
npm run sample
npm run sample -- --id <id>
npm run demo
npm run preview
npm run typecheck
npm test
npm run publish -- --dry-run
npm run publish -- --id <id>
npm run publish -- --id <id> --now
npm run reconcile -- --id <id>
npm run recover -- --id <id> --platform <instagram|threads> --confirm-not-published --evidence "<checked evidence>"
npm run retry-failed -- --id <id> --platform <instagram|threads> --confirm-not-published --evidence "<checked evidence>"
npm run state:init
```
