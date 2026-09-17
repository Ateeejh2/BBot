# 検証記録

2026-09-17、開発環境Linux / Node.js v24.19.0 / npm 11.9.0で実施。

| 検証 | 結果 |
| --- | --- |
| TypeScript strict build | 成功 |
| Node組込みrunnerの自動テスト | 38件成功 |
| CLIのMock起動→イベント完了→quit→snapshot確認 | 成功（自動テスト内） |
| 20 Mockクライアント、10秒の合成負荷 | 成功 |
| 200回の経路キャンセル後のabort listener | 残存0（Unit対象） |
| Gitへの秘密ファイル混入 | 除外設定・tracked file一覧を確認 |
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

## 残っている検証・仕様

- 実サーバーで通知がsystem messageとして届くか、通知とspawnの順序。
- spawn/respawnを伴わないLobby復帰の検出方法。
- AFKの正確なchat message、正式Event API、到着後の処理、Lobbyへの実コマンド。
- Windowsでの初回認証・終了時socket cleanup・snapshot rename・ログrotation。
- TaskHandlerがsignalを無視する場合の外部効果までは取り消せない。実pluginは冪等・協調キャンセルが必須。
- Snapshot保存間隔内のクラッシュによる更新消失と再実行。厳密なtransactional処理が必要になればstoreを差し替える。
- 同じDATA_DIRを複数プロセスで共有する運用は対象外。
