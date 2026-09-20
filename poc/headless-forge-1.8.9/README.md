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

このPoCは `poc/headless-forge-1.8.9/` 以下だけで完結します。

- `src/` は変更しない
- Node API は変更しない
- BBot-Web は変更しない
- 既存の `feature/windows-bbot` branch は変更しない

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
- HMC-Specifics is installed by HeadlessMC's `-specifics` launch flag
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
launch forge:1.8.9 -specifics -lwjgl --jvm "-Djava.awt.headless=true -Xms256m -Xmx768m"
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

Forgeはbridgeへ現在のposition / yaw / pitch / onGround / sprint / collision / flight stateをJSON Linesで送ります。Node側からはforward / sprint / sneak / look / chatを送れます。

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

次段階ではこのlocalhost bridgeを既存 `BotTransport` のForge実装へ接続し、Web/API側の契約を維持したままMineflayer transportを置き換えます。
