# 検証記録

2026-09-17、開発環境Linux / Node.js v24.19.0 / npm 11.9.0で実施。

| 検証 | 結果 |
| --- | --- |
| TypeScript strict build | 成功 |
| Node組込みrunnerの自動テスト | 40件成功（ローカルLinux） |
| CLIのMock起動→イベント完了→quit→snapshot確認 | 成功（自動テスト内） |
| 20 Mockクライアント、10秒の合成負荷 | 成功 |
| 200回の経路キャンセル後のabort listener | 残存0（Unit対象） |
| Gitへの秘密ファイル混入 | 除外設定・tracked file一覧を確認 |
| 1.8.9オフラインprotocol 47とserializer/deserializer、plugin API export | 追加テスト実施（接続保証ではない） |
| Windows 10/11実機 | 未実施 |
| Microsoft認証 / Minecraft接続 / 実pathfinder移動 | 未実施 |
| 20実Bot・24/7運転・実Mineflayer listener長期挙動 | 未実施 |
| Oracle Cloud / ARM64/Linux運用 | 実施対象外・デプロイなし |

20 Mock負荷の一例:

- 10秒、1,925ループ（論理時刻を加速）
- 600イベント受付、452完了、64回の模擬復旧
- 同時path上限実測2、Job保持200/設定上限200、instance保持7
- heap開始8,417,128 bytes、終了10,940,600 bytes、RSS57,573,376 bytes
- CPU user351.388ms、system52.235ms

この試験は実Minecraftパケット、chunk、entity、実A*探索、認証を含みません。数値は繰返しで変動します。20実Botの容量見積り、24/7安定性、メモリリークなしの証明には使えません。Windowsで段階的に計測を続けてください。

## 依存監査

`npm audit --omit=dev --json`の実行時、**moderate 6件、high/critical 0件**。uuid `<11.1.1`のbuffer bounds指摘 [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) と、`@azure/msal-node` / `yggdrasil` / `prismarine-auth` / `minecraft-protocol` / `mineflayer`への依存伝播です。6つの独立した脆弱性を意味するものではありません。

npmが提示した自動修正はMineflayer 1.4.0への大幅変更で、現在のAPI互換性を壊す可能性があるため実行していません。認証依存のmajor overrideも実認証未検証のまま追加していません。依存更新を追跡し、実機安定運用の前に再評価してください。この指摘を解決済みとは扱いません。

## 1.8.9互換性の境界

[Mineflayer公式README](https://github.com/PrismarineJS/mineflayer)はMinecraft 1.8系列を対象にし、`version: "1.8.9"`を指定例に挙げる。[node-minecraft-protocol公式README](https://github.com/PrismarineJS/node-minecraft-protocol)は対応一覧に1.8.8を掲げ、1.8.9をversion指定例に挙げる。lockfileの`minecraft-data`は1.8.9指定をプロトコル47/1.8.8系データへ解決する。導入済みライブラリのserializer/deserializerとpathfinder exportをオフラインで確認した。プロトコル番号の整合だけで1.8.9実サーバーの挙動は保証しない。[mineflayer-pathfinder公式README](https://github.com/PrismarineJS/mineflayer-pathfinder)にも、1.8.9固有の全機能の動作確認結果は示されていない。

Mineflayer経路のspawn/respawn、chat/system message、backend切替、block/movement physics、pathfinder、inventory/windowは引き続き1.8.9実機テスト待ち。Headless Forge経路のWeb操作ライフサイクル（Launch / Start / Disconnect / 再Start / Quit）は2026-09-20にCodespaces上の実Minecraft 1.8.9クライアントで確認した。最新版向けの挙動を1.8.9へそのまま当てはめていない。

## 残っている検証・仕様

- 実サーバーで通知がsystem messageとして届くか、通知とspawnの順序。
- spawn/respawnを伴わないLobby復帰の検出方法。
- AFKの正確なchat message、正式Event API、到着後の処理、Lobbyへの実コマンド。
- Windowsでの初回認証・終了時socket cleanup・snapshot rename・ログrotation。
- TaskHandlerがsignalを無視する場合の外部効果までは取り消せない。実pluginは冪等・協調キャンセルが必須。
- Snapshot保存間隔内のクラッシュによる更新消失と再実行。厳密なtransactional処理が必要になればstoreを差し替える。
- 同じDATA_DIRを複数プロセスで共有する運用は対象外。


## 2026-09-20 Headless Forge / Web control 検証

Codespaces / Linux / Java 8 / HeadlessMC / Forge 1.8.9 の実クライアントを使用して、Web control の基本ライフサイクルを手動検証した。

確認済み:

- `Launch`: HeadlessMC経由でForge 1.8.9 clientが起動し、bridgeが `LAUNCHED` になる。
- `Start`: Webに保存されたMinecraft serverへ接続し、spawn後5秒待機、`/play pit`、instance確認を経てIdleへ到達する。
- `Disconnect`: Minecraft server sessionだけを切断し、Forge worker / bridgeは `LAUNCHED` のまま保持される。
- Disconnect後の再 `Start`: 同じForge transportを再利用して再接続できる。
- `Quit`: Forge workerを停止し、BotはDisconnectedへ揃う。
- Start / Disconnectの連打、Start中のQuit、接続失敗後の復帰を手動確認。
- Webの狭いカード幅で lifecycle buttons が見切れず折り返すことを確認。
- Performance表示がNode processではなくHeadlessMC + Minecraft process treeのForge CPU/RSSを示し、MC pingをForge bridgeから取得することを確認。

この挙動を固定するため、`test/forge-lifecycle.test.ts` に以下の回帰テストを追加した。

- server Disconnect後もForge transportをcloseしない。
- Disconnect後のStartで同じtransportを再利用する。
- 再接続失敗時もForge transportを保持したままDisconnectedへ戻れる。
- 二重Start / 二重Disconnectを状態エラーとして拒否する。

### Codespacesでのローカル検証

Backend + Node tests + Forge mod build:

```bash
cd /workspaces/BBot
git pull --ff-only
npm ci
npm run validate:forge-local
```

Web:

```bash
cd /workspaces/BBot-Web
git pull --ff-only
npm ci
npm test
npm run build
```

実Minecraftを含む最終E2Eは、Backend/Web起動後に次の順で確認する。

```text
Launch
→ Start
→ Idle
→ Disconnect
→ Forge LAUNCHEDのまま
→ Start
→ Idle
→ Disconnect
→ Quit
→ Forge STOPPED
```

2026-09-20時点ではGitHub Actionsの月間利用上限到達のため、BBot側Actionsの赤表示をコード品質の判定には使用していない。この検証ラウンドではCodespaces上のローカルbuild/testと上記手動E2Eを基準とする。
