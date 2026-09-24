# BBot

管理・テストを許可されたMinecraft環境向けの、クライアント側だけで動くBot管理システムです。Node.js / TypeScript / Mineflayerを使い、1プロセスで最大20クライアントを管理します。サーバーのコード・設定変更は不要です。

**現在はWindows実機検証前の開発版です。24/7運用の安定性は未確認です。Oracle Cloudへのデプロイ、ARM64/Linux運用対応は実施していません。** 開発環境のLinuxでMockテストが通ったことと、Windowsで実接続できることは別です。

## 構成

| 領域 | 責務 |
| --- | --- |
| `src/config`, `src/logging` | 検証付き設定、JSONログ、サイズ・世代上限付きファイルログ |
| `src/core` | 型、状態遷移、世代トークン、JSON永続化、共有タイマー |
| `src/bot` | Bot Manager、Mineflayer adapter、Mock transport |
| `src/instances` | 独立parser、動的Registry、回数制限付き分散 |
| `src/events` | Mock/HTTP EventProvider、TaskHandler拡張点 |
| `src/scheduler` | 同instanceの候補選択、Job割当・返却・期限・lease |
| `src/pathfinding` | キュー、同時数制限、timeout/cancel |
| `src/recovery` | 再接続backoff/jitter、キャンセル可能な待機 |
| `test`, `scripts/soak.ts` | Minecraft不要のテスト・短時間Mock負荷試験 |

設計の詳細と未確定仕様は [docs/architecture.md](docs/architecture.md)、実測値と制約は [docs/validation.md](docs/validation.md) を参照してください。

## Windows 10/11での準備（PowerShell）

Node.js 24系または22系、Gitを使用します。まずNode.js 24系で試してください。対応対象バージョンを`engines`で22〜24に制限しています。実際のWindows検証結果はまだありません。

```powershell
node --version
npm.cmd --version
git --version

git clone https://github.com/Ateeejh2/BBot.git
Set-Location BBot
git switch feature/windows-bbot

npm.cmd install
Copy-Item .env.example .env
notepad .env
npm.cmd run build
npm.cmd test
```

`npm.cmd`はPowerShellの実行ポリシーによる`npm.ps1`拒否を避けるために使用しています。コマンドは各行で実行し、失敗したら先へ進まず表示を確認してください。既存の`.env`がある場合は上書きせず比較してください。lockfileから再現する場合は`npm.cmd ci`を使います。

既定の`.env`は`MODE=mock`、`BOT_COUNT=1`です。MockではMinecraftへ接続せず、模擬instanceへの移動と安全な到着処理を行います。

```powershell
npm.cmd run start:mock
```

起動後、コンソールに`status`を入力するとBotの状態を表示します。`quit`を入力すると、Jobを返却し、接続を終了し、状態を保存します。`Ctrl+C`でも終了できます。終了ログ`BBot stopped`を待ってからウィンドウを閉じてください。ライブラリが通信ハンドルを保持する場合は保存後最大10秒で終了します。ウィンドウの強制終了は最終保存を保証しません。

## 1 Botで実接続する

先にUnit/Mockテストを通してください。実アカウント情報は**ローカルの**`accounts.json`だけに設定します。

```powershell
Copy-Item accounts.example.json accounts.json
notepad accounts.json
notepad .env
```

`accounts.json`の`username`を自分の認証用識別子に置き換えます。通常は`auth: "microsoft"`です。`label`は秘密情報ではない識別名（例`test-01`）にしてください。`offline`は管理者が明示的にoffline認証を許可したテストサーバー専用です。アカウント共有や認証回避は行いません。

`.env`を次のように変更します。hostは実環境に合わせて入力してください。テスト対象versionは`1.8.9`です。

```dotenv
MODE=live
BOT_COUNT=1
SERVER_HOST=YOUR_AUTHORIZED_ENTRY_HOST
SERVER_PORT=25565
MC_VERSION=1.8.9
TRANSFER_MESSAGE_CHANNEL=system
ACCOUNTS_FILE=accounts.json
DEBUG=true
LOG_DIR=logs
DISTRIBUTION_ENABLED=false
```

`MC_VERSION`の既定値は`1.8.9`です。空欄にしても`1.8.9`になります。実機テストでは自動検出に頼らず、入口へこのversionを明示して接続します。特定ネットワーク上での動作は未検証です。

```powershell
npm.cmd run build
npm.cmd start
```

初回Microsoft認証では、本人操作用のURLと一時コードをコンソールだけに表示します。構造化ログには保存しません。認証キャッシュは`.auth`に保存します。認証手順に60秒以上かかる場合は、`CONNECT_TIMEOUT_MS`をローカルで延長してください。画面録画やコンソール全体の共有には一時コードが含まれる可能性があります。

spawn後、cooldownを待って`/play pit`を送信します。`/server`は使いません。既定で送信されるコマンドは`/play pit`だけです。実モードでは外部Event APIは未設定で、Mockイベントも自動発行しません。接続・所属検出・復旧を先に検証するためです。

**到着判定の制約:** 初期設定ではserver systemチャットの`SERVER FOUND! Sending to <INSTANCE>!`を受信し、その後のspawnを確認した場合だけ所属を確定します。通知だけでは移動を開始しません。通知より先にspawnが来る環境や、通知がsystemチャットとして届かない環境では確定せずtimeoutになります。`DEBUG=true`時の`transfer text observed`には、内容や認証情報を記録せず受信channel・送信者の有無・判定可能性を記録します。1.8.9でchat channelに届くことを実測で確認した場合だけ`TRANSFER_MESSAGE_CHANNEL=chat`へ切り替えて再試験してください。chat channelには送信元を認証できない場合があるため、完全一致のプレイヤー文をサーバー通知と誤認するリスクがあります。通知・イベントの順序が異なる場合は、実際の観測結果に合わせてadapterを修正してください。

## ローカルCare Packageテストサーバー

Care Packageの実イベント待ちを避けるため、Spigot 1.8.8上で疑似Care Packageを何度でも再現できるテストハーネスを `test-server/` に用意しています。

```bash
npm run test-server:setup
npm run test-server:use
npm run test-server:start
```

別ターミナルでBBotを起動し、Dashboardから `bot-1 → Launch → Start`。ローカルプラグインが `/play pit` を疑似転送して `caretest` instanceへ入れます。Idle後、テストサーバーのコンソールで `caretest start` を実行すると、Chest生成 → 共有click残数 → OPEN → Mystic/Fresh lootまで再現します。

KB、Chest消去、loot遅延も `caretest knockback` / `caretest autokb` / `caretest vanish` / `caretest lootdelay` で再現できます。詳細は [test-server/README.md](test-server/README.md) を参照してください。終了後は `npm run test-server:restore` で通常の `.env` に戻します。

Vulcan等の第三者プラグインjarは同梱しません。ライセンス済みjarを `test-server/runtime/plugins/` に置けば通常のSpigotプラグインとして読み込まれます。このテストは互換性・flag観測用であり、特定のアンチチート回避を目的にしません。

## Debugログと復旧確認

別のPowerShellで、リポジトリのディレクトリから確認します。

```powershell
Get-Content .\logs\bbot.jsonl -Tail 50 -Wait
```

JSONログにtimestamp、botId、accountLabel、instance、state、eventId/jobIdを含みます。該当しない欄はnullです。`runtime metrics`は60秒ごとにRSS/heap/CPU、Job数、確認済みinstance数、探索数を出します。`DEBUG=true`でイベント取得、spawn/respawn、転送通知候補のchannel、window open/close、inventory slot数の診断情報を追加します。内容そのものやslotのアイテムは記録しません。生チャット・認証応答・例外全文は記録しません。

起動中のBBotコンソールで使える操作:

| 入力 | 動作 |
| --- | --- |
| `status` | Bot状態と所属を表示 |
| `recover bot-1` | オペレーターがLobby復帰を確認したBotをUNKNOWN_RETURNとして復旧 |
| `quit` | 経路停止・Job返却・接続終了・保存 |

通常respawnだけでLobby/AFKを断定しません。未知のワールド切替を検出したときは所属を破棄し、`RECOVERING`に移行して次のspawn後に`/play pit`で同期し直します。これにより死亡respawnでも再同期する場合があります。逆に、respawnを伴わないLobby復帰は現状自動検出できません。`recover`または正確なLobby検出adapterが必要です。AFKの推測メッセージやTitle判定は実装していません。

`join attempt budget exhausted`が出たBotは自動再試行を停止します。通知形式・順序・接続設定を確認してからプロセスを再起動してください。失敗を放置してコマンドを無限送信しません。

## 段階的テスト

各段階の確認後にだけ次へ進んでください。全台に同じアカウントを使わず、人数分の重複しないアカウントを`accounts.json`に並べます。

| 段階 | 設定・確認内容 |
| --- | --- |
| 0: Unit / Mock | `npm.cmd test`、`start:mock`、終了・保存・復元 |
| 1: 実1 Bot | `BOT_COUNT=1`。認証、spawn、`/play pit`、所属、再接続 |
| 2: 実2 Bot | `BOT_COUNT=2`。接続間隔、別instance、単独復旧と同時復旧 |
| 3: 実少数 | `BOT_COUNT=3`〜`5`。新instance・消失・期限切れJob、長時間計測 |
| 4: 実20 Bot | 前段階合格後に`BOT_COUNT=20`。CPU/RSS、探索上限、継続運転 |

実機でのイベント移動試験は、管理されたテスト用座標のイベントをProviderへ注入し、TaskHandlerをMockのまま試してください。`src/index.ts`のProvider組み立て箇所が拡張点です。外部API仕様未定のため、架空のAPIやliveイベントは接続していません。

Mock負荷試験はMinecraftを使わず20個の軽量transportで行います。

```powershell
npm.cmd run test:soak
# 長めのMock試験（実20 Botの代わりにはなりません）
$env:SOAK_SECONDS = "60"
npm.cmd run test:soak
Remove-Item Env:SOAK_SECONDS
```

[1.8.9 Windows確認表](docs/windows-checklist.md)へ結果を記入してください。GitHub ActionsにはWindows runnerのUnit/Mockテストを用意しています。CI合格もWindows 10/11実機やMinecraft接続の確認済みを意味しません。

## 主な設定

全設定と既定値は`.env.example`にあります。変更後は再起動してください。PowerShellの`$env:...`が残っていると`.env`より優先されます。

| 設定 | 既定値・用途 |
| --- | --- |
| `MODE`, `BOT_COUNT` | `mock`, `1`。台数は1〜20 |
| `SERVER_HOST`, `SERVER_PORT`, `MC_VERSION` | 入口host、25565、1.8.9（空欄も1.8.9） |
| `TRANSFER_MESSAGE_CHANNEL` | system。1.8.9の実測結果に応じて明示的にchatへ変更可能 |
| `RECONNECT_BASE_MS`, `RECONNECT_MAX_MS`, `RECONNECT_JITTER_PERCENT` | 5000、120000、50%。指数backoffとばらつき |
| `CONNECTION_SPACING_MS`, `CONNECT_TIMEOUT_MS` | 3000、60000。全体の接続間隔とspawn待機上限 |
| `PLAY_COOLDOWN_MS`, `JOIN_TIMEOUT_MS`, `JOIN_MAX_ATTEMPTS` | 15000、30000、5 |
| `PATH_CONCURRENCY`, `PATH_TIMEOUT_MS` | 2、30000。移動中の再探索もslotを保持 |
| `TASK_TIMEOUT_MS`, `JOB_MAX_ATTEMPTS`, `JOB_RETRY_MS` | 10000、3、5000 |
| `EVENT_POLL_MS` | 10000。全Botで1つのFetcherを共有 |
| `MAX_JOBS`, `MAX_INSTANCES` | 2000、1000。履歴の上限 |
| `INSTANCE_SUSPECT_MS`, `INSTANCE_INACTIVE_MS` | 300000、1800000。空instanceの観測経過時間 |
| `LOG_LEVEL`, `DEBUG`, `LOG_DIR` | info、false、logs |
| `LOG_MAX_BYTES`, `LOG_FILES` | 5000000、3。現行ファイル+最大3世代 |
| `DATA_DIR` | data。Mock/liveで保存ファイルを分離 |
| `DISTRIBUTION_ENABLED`, `LOBBY_COMMAND` | false、未設定。実環境で確認したLobbyコマンドだけ設定 |
| `REROLL_MAX_ATTEMPTS`, `REROLL_COOLDOWN_MS` | 3、60000。Botごとの起動期間内の上限 |

分散は確認済みACTIVE instanceのみを評価します。総instance数と断定しません。Lobbyへのコマンドが未確認のため、自動再抽選は既定で無効です。実環境で有効なLobbyコマンドと転送動作を確認してから有効にしてください。特定instanceの直接指定はしません。配置が均等に近い場合、Botよりinstanceが多い場合は無理に全instanceを埋めません。新規instanceの発見は実際の転送があった場合のみで、均等配置時に発見目的の無限再抽選はしません。

## 永続化・秘密情報・運用範囲

ローカルJSON snapshotは5秒ごとと正常終了時に保存します。temp書込み・flush・renameと1世代backupを使い、再起動時の未完了Jobを再queueします。Bot所属は復元せず再観測します。電源断・プロセスクラッシュ直前の最大約5秒の更新消失や、到着処理の再実行はあり得ます。将来の実TaskHandlerはevent IDを用いて冪等化してください。複数プロセスで同じDATA_DIRを共有しないでください。

`.env`、`accounts.json`、`.auth`、`data`、`logs`はGit除外済みです。実アカウントやtokenをソース・サンプル・Job metadataに入れないでください。追加の秘密ファイル名を使う場合は必ず`.gitignore`へ追加します。

```powershell
git status --short
git check-ignore .env accounts.json .auth data logs
```

依存関係はlockfileで固定しています。監査で判明した未解決の依存指摘は[検証記録](docs/validation.md)に記載しています。`npm audit fix --force`による互換性不明な大幅変更は行っていません。

Windows安定化後に、別フェーズでOracle Cloud ARM64/Linux対応を検討します。このリポジトリにデプロイスクリプト・systemd・Linux専用起動処理はありません。
