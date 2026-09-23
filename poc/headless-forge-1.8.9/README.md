# BBot Headless Forge 1.8.9 PoC

BBot の既存 Node.js / Web 実装を変更せず、Forge 1.8.9 の実クライアント movement を headless で試すための独立 PoC です。

## 何を確認するPoCか

Mineflayer / prismarine-physics を使わず、Minecraft Forge 1.8.9 本体に movement packet を生成させます。

接続後、デフォルトでは次の順で自動テストします。

1. 15秒待機
2. 10秒 forward
3. 10秒 forward + sprint
4. 停止

移動は `KeyBinding` だけを操作します。position / velocity / packet を直接書き換えません。

ログには `[BBotPoC]` というprefixで phase、position、velocity、yaw、onGround、sprint、horizontal collision を出します。
1tickで大きく位置が変わった場合は `position-jump` も記録します。

## 既存BBotへの影響

このexperiment branchでは、PoC検証後に `src/bot/forge.ts` とtransport切り替え設定を追加しています。

- Node API / BotManager / BBot-Webの外部契約は維持する
- Minecraft I/OだけをMineflayerまたはForgeTransportで切り替える
- 通常の `feature/windows-bbot` branch は変更しない

PoC branch:

`experiment/headless-forge-1.8.9`

## 必要なもの

OCI/Linux 側に以下が必要です。

- Java 8 JDK
- curl
- unzip
- 正規の Minecraft Java アカウント

HeadlessMC はログイン済みの正規アカウントを要求します。

Java 8 が複数ある場合は:

```bash
export JAVA8_HOME=/path/to/jdk8
```

## 1. branchを取得

```bash
cd /workspaces/BBot
git fetch origin
git switch experiment/headless-forge-1.8.9
git pull --ff-only
```

## 2. Forge modをbuild

```bash
cd /workspaces/BBot/poc/headless-forge-1.8.9
chmod +x scripts/*.sh
./scripts/build.sh
```

初回のみ Forge 1.8.9 workspace を作るため時間がかかります。

生成物:

```text
build/libs/bbot-headless-poc-0.1.0.jar
```

## 3. HeadlessMCを準備

```bash
./scripts/bootstrap-headless.sh
```

このscriptは次をPoC専用 `runtime/` に配置します。

- HeadlessMC 2.10.0
- pinned HMC-Specifics for Forge 1.8.9 (downloaded during bootstrap, not at Launch time)
- BBot Headless PoC mod
- HeadlessMC config

既存のBBotやWebの設定ファイルは触りません。

## 4. HeadlessMCを起動

```bash
./scripts/run-hmc.sh
```

HeadlessMC のpromptが出たら、最初の1回は:

```text
login
```

でMinecraftアカウントにログインします。

次にForge 1.8.9をheadless起動します。

```text
launch forge:1.8.9 -lwjgl --jvm "-Djava.awt.headless=true -Xms256m -Xmx768m"
```

起動後、hmc-specifics のcommandでテスト対象サーバーへ接続します。

```text
connect SERVER_HOST 25565
```

接続後15秒でPoC movement testが自動開始します。

## 半ブロック地点で試す場合

サーバーが前回位置を保持する場合は、先に通常クライアントで半ブロック上へ移動してlogoutし、そのアカウントでPoCを接続するのが簡単です。

待機時間を長くしたい場合:

```bash
BBOT_POC_WARMUP_TICKS=1200 ./scripts/run-hmc.sh
```

1200 ticks = 約60秒です。

## テスト時間を変える

すべて20 ticks ≒ 1秒です。

```bash
export BBOT_POC_WARMUP_TICKS=300
export BBOT_POC_WALK_TICKS=200
export BBOT_POC_SPRINT_TICKS=200
export BBOT_POC_TRACE_EVERY_TICKS=20
./scripts/run-hmc.sh
```

## Localhost bridge

PoCにはNode ↔ Forgeの最小bridgeがあります。Forge側は `127.0.0.1:3010` にだけbindし、外部インターフェースへは公開しません。

Forgeはbridgeへ現在のposition / yaw / pitch / onGround / sprint / collision / flight stateをJSON Linesで送ります。Node側からはforward / sprint / sneak / jump / look / chatを送れます。spawn / worldReset / identity / filtered chat / chicken spawn / chest block-changeもbridge eventとしてNodeへ渡します。

Forge起動・サーバー接続後、別ターミナルで:

```bash
cd /workspaces/BBot/poc/headless-forge-1.8.9
node scripts/bridge-client.mjs
```

対話クライアントでは:

```text
forward on
forward off
sprint on
sprint off
sneak on
sneak off
jump on
jump off
look -90 0
chat hello
release
quit
```

最初の `controls` コマンドを受けると、そのworldでは自動PoC movementを停止し、bridgeがKeyBindingを制御します。`release` やbridge切断時はキーを解放しますが、自動テストは勝手に再開しません。worldを抜けるとこの状態はリセットされます。

ポートを変える場合はForgeとNode側で同じ値を指定します。

```bash
export BBOT_POC_BRIDGE_PORT=3011
./scripts/run-hmc.sh
```

別ターミナル:

```bash
BBOT_POC_BRIDGE_PORT=3011 node scripts/bridge-client.mjs
```

bridge自体を無効にする場合:

```bash
BBOT_POC_BRIDGE_ENABLED=false ./scripts/run-hmc.sh
```

## BBot本体でForgeTransportを使う

このbranchでは既存 `BotTransport` に `ForgeTransport` を追加済みです。Web/API/state machineを変更せず、live transportだけを切り替えます。

```bash
MODE=live
BBOT_TRANSPORT=forge
BOT_COUNT=1
FORGE_BRIDGE_BASE_PORT=3010
```

`bot-1` は3010、`bot-2` は3011というように、`FORGE_BRIDGE_BASE_PORT + bot index` を使います。10 botなら3010〜3019です。bridgeはすべて `127.0.0.1` のみで、外部公開しません。

現在ForgeTransportでつながっているもの:

- position
- spawn / worldReset / identity / end
- transfer/Care Package announcement用chat filtering
- chat送信
- navigate / stopPath
- launchToward（slime pad query + approach + launch/landing判定）
- chickenSpawn
- chestAppeared

Forge Viewer（実験実装済み）:

- `VIEWER_BOT_ID` で選択した1体だけworld/chunk snapshotを要求
- Forge 1.8.9のblock stateをViewer側では1.8.8互換として描画
- initial chunk + S22/S23 block update + bot position/yaw/pitchをLive Viewへ送信
- Viewer HTTPは `127.0.0.1:VIEWER_PORT` にbindし、OCIではCloudflare/reverse proxy経由で公開する
- chunkは必要時に1個ずつ取得し、10 bot全部へViewer負荷をかけない

まだ移植途中のもの:

- Viewerの他entity同期（現在はworld + 選択bot位置が中心）
- NodeからForge workerを自動起動/停止するworker supervisor
- Webのaccount assignmentとForge workerのMinecraft login/profileを1:1で管理するproduction worker lifecycle

## 最終デプロイ想定: OCI + Cloudflare

最終構成はCodespace固有機能に依存させません。

```text
Cloudflare
  ├─ BBot-Web
  ├─ /api/v1 -> OCI上のBBot API
  └─ Live View -> OCI上のViewer

Oracle OCI (2 OCPU / 12GB想定)
  ├─ Node BBot
  │    └─ API 127.0.0.1:3008
  ├─ Forge worker bot-1 -> bridge 127.0.0.1:3010
  ├─ Forge worker bot-2 -> bridge 127.0.0.1:3011
  ├─ ...
  └─ Forge worker bot-10 -> bridge 127.0.0.1:3019
```

Cloudflare側へ公開するのはWeb/API/Viewerの入口だけです。Forge bridgeポート3010〜3019はOCI内のlocalhost専用のままにします。既存configも `API_HOST=127.0.0.1` を要求するため、この構成に合わせています。

## Headless render最適化

接続中はデフォルトで `Minecraft.skipRenderWorld=true` を維持し、Minecraft本体のworld renderをスキップします。

これはclient tick / network / world / chunk / entity stateを止めるものではありません。将来のWeb ViewerはForge bridgeからworld/chunk/entity/positionをNode側へ渡し、prismarine-viewerのcore/standalone側で描画する想定なので、Minecraft側の画面renderとは分離できます。

A/B比較でrenderを戻す場合:

```bash
BBOT_POC_SKIP_RENDER=false ./scripts/run-hmc.sh
```

ログの `ready ... skipRender=true` で有効状態を確認できます。

## メモリについて

最初はMinecraft側を `-Xmx768m` で試します。

より厳しいOCIなら `-Xmx512m` も試せますが、起動時OOMになる場合は戻してください。

HeadlessMC configでは `hmc.assets.dummy=true` を有効にして、asset downloadとメモリ負荷を抑えています。

## 停止

Minecraft側はHeadlessMC/hmc-specificsの `quit` command、またはプロセス停止で終了できます。

## 成功判定

最低限、次を確認します。

- GPU/X serverなしでForge 1.8.9が起動する
- サーバーへ接続できる
- `[BBotPoC] phase=WALK` と `phase=SPRINT` が出る
- 通常移動でserver position correctionループにならない
- 半ブロックからの移動でも同じ問題が再現しない
- OCI上のRAM/CPUが許容範囲

次段階ではForge Viewerの実動作を確認し、他entity同期を補完した後、Nodeが10個のForge workerを管理するproduction worker supervisorを追加します。
