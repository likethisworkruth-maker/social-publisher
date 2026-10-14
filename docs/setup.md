# 初回セットアップ

更新日：2026-10-09。初期対象はInstagram・Threadsへの画像1枚またはカルーセル投稿です。

## 1. アカウントなしで確認する

Node.js 22.17以降で、プロジェクトのフォルダから実行します。

```powershell
npm ci
npm run typecheck
npm test
npm run demo
npm run sample
npm run validate
npm run preview
```

サンプルは公開無効です。ローカルデモは模擬結果を使い、本番認証情報やネットワークを使用しません。通常の `publish` はGitHub Actionsを起動するため、接続前は `--dry-run` を付けてください。

`preview` は必ずローカルDry Runになります。Windows PowerShellでIDなどを指定する場合は、引数を確実に渡せる `npm.cmd` を使います：`npm.cmd run publish -- --dry-run --id sample-post`。

## 2. 専用GitHubアカウントへ接続する（アカウント準備後）

この手順はまだ実行していません。先に新アカウントのユーザー名と作成するリポジトリを決めます。パスワードやアクセストークンをチャットに貼る必要はありません。認証はPCのGitHub CLI／ブラウザーで行い、SNSトークンはGitHub Secretsへ登録します。

既存アカウントとログイン情報を分ける場合は、このプロジェクト用のPowerShellで次の設定を行います。GitHub CLIの設定先を別フォルダにし、このセッションの認証用環境変数を外します。既存CLIの通常の設定フォルダやグローバルGit設定は変更しません。

```powershell
$env:GH_CONFIG_DIR = Join-Path $env:LOCALAPPDATA 'social-publisher\gh'
Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
gh auth login --hostname github.com --git-protocol https --web
gh api user --jq .login
```

表示された名前が専用アカウントであることを確認します。このログイン設定を使うターミナルを開き直したら、`GH_CONFIG_DIR` を再設定してください。コマンドの認証はその設定先を使います。

Gitの投稿用メールアドレスと名前は、このリポジトリだけに設定します。下記のプレースホルダーは実際の値に置き換えます。`--global` や `gh auth setup-git` はこの手順では使いません。

```powershell
git config --local user.name '専用アカウントの名前'
git config --local user.email '専用アカウントのGitHub非公開メールアドレス'
```

リポジトリ作成、remote登録、commit、pushはユーザー名・公開範囲・リポジトリURLの確定後に行います。既存remoteがある場合は、内容を確認してから接続先を設定します。

公開リポジトリ＋GitHub Pagesを選ぶと、本文・画像・日時がpushした時点で公開されます。非公開リポジトリを選ぶ場合は、既存のHTTPS画像ホストを利用するか、Pagesの契約条件を確認します。無料運用の条件・制限はREADMEに記載しています。

## 3. リポジトリの設定

リポジトリを既定ブランチへpushし、GitHub CLIがそのリポジトリを参照する状態にしてから実行します。

```powershell
npm run state:init
```

これはリモートに専用状態ブランチを作成する操作です。既存状態をリセットしません。

Settings → Pages → Sourceを **GitHub Actions** に設定し、`Prepare public image assets` workflowのデプロイ成功と画像の匿名HTTPS GETを確認します。最初のpushで失敗した場合、状態ブランチとPages設定を終えた後にそのrunを再実行してください。

Settings → Secrets and variables → Actionsで登録します。

| 区分 | 名前 |
| --- | --- |
| Secrets | `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID`, `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID` |
| Variables | `INSTAGRAM_API_VERSION`, `THREADS_API_VERSION`, `INSTAGRAM_TOKEN_EXPIRES_AT`, `THREADS_TOKEN_EXPIRES_AT` |
| 画像配信 | `ASSET_MODE=pages`。既存ホストなら `fixed-url` と `ASSET_BASE_URL` |
| 予約運用 | 必要に応じて `MAX_LATENESS_MINUTES`, `MAX_POSTS_PER_RUN` |

InstagramにはInstagram Loginで認可したプロアカウントを使います。Threads用トークンは独立して取得します。使用できるAPI版、投稿権限、トークン期限、投稿枠照会の実応答は [Phase 0確認表](phase-0-verification.md) に記録します。期限切れ前にトークンを更新してSecretsと期限Variablesを入れ替えます。自動更新は今回の実装に含まれません。

## 4. 初回の実投稿確認

公開する内容とアカウントを決め、サンプル画像・本文・日時を差し替えます。サンプルをそのまま有効化せず、使わないサンプルは無効のままにしてください。

1. ローカルvalidate／Dry Runで内容を確認する。
2. 完成した投稿をcommit／pushし、画像公開workflowの成功を確認する。
3. Actionsの `Publish and reconcile` を `action=dry-run` と投稿IDで実行する。
4. 確認後に同じ投稿IDで `action=publish` を選ぶ。即時テストなら `publish_now=true` を明示する。
5. 両SNSの実投稿と状態保存を確認し、同じIDで再実行して再送されないことを確認する。
6. 複数画像・予約実行の確認へ進む。

ローカルテストの成功は実接続の成功を意味しません。結果不明になった場合はREADMEの照合手順を使い、未公開と確認できるまで再送をしません。
