# Windows実機確認表（未実施）

ここは自動テスト結果ではなく、ユーザーのWindows環境で記録する確認表です。

- 実施日 / Windows版・build:
- Node / npmバージョン:
- BBot commit:
- CPU / RAM:
- Minecraft版 / 認証方式（秘密は記載しない）:
- 台数 / 試験時間:

| 確認項目 | 結果・測定値 |
| --- | --- |
| PowerShellでnpm install/build/testが成功 | 未確認 |
| Mock起動、Job完了、quit、snapshot復元 | 未確認 |
| Windowsのパス・ログrename/rotation・ファイルロック | 未確認 |
| 1 Bot認証（初回/キャッシュ）、入口spawn | 未確認 |
| `/play pit`のcooldownと転送通知の種類・順序 | 未確認 |
| 通知後spawnで正しいinstanceが確定 | 未確認 |
| 通知欠落・逆順時にJobが実行されずtimeoutする | 未確認 |
| 入口接続失敗・通信断・再接続時の待機とjitter | 未確認 |
| Pit死亡/respawn時に古い経路が停止 | 未確認 |
| Lobby復帰時の検出可能性、未知復帰の再同期 | 未確認 |
| AFKの正確なchat text（判明後に別途parser追加） | 未確定 |
| 同instance複数Botの同時復帰でSUSPECTになる | 未確認 |
| 新instance・消失・同ID再登場 | 未確認 |
| 過密配置の再抽選上限、確認したLobbyコマンド | 未確認 |
| 管理された座標への経路探索/timeout/キャンセル | 未確認 |
| 移動中の転送後、古い完了処理が状態を変えない | 未確認 |
| 実Task追加前はMock到着処理のみ | 未確認 |
| 2 Bot、3〜5 Botの段階的な長時間運転 | 未確認 |
| 各段階のRSS/heap/CPUの開始値・ピーク・終了値 | 未確認 |
| listener警告・UnhandledPromiseRejectionがない | 未確認 |
| ログサイズ上限・Job/instance上限・queue長 | 未確認 |
| Ctrl+C/quitで保存・切断、再起動で重複Jobがない | 未確認 |
| 最後に20実Bot、24時間以上の観測 | 未確認 |

`runtime metrics`を定期比較し、heapがGC後も一方向に増え続けないか、CPUが飽和しないかを観測します。短時間Mockの数値から20実クライアントの必要メモリを推定しないでください。実到着処理/API導入後はその負荷も再評価します。

不具合時は台数を戻し、commit・時刻・botId・状態遷移・instance・jobIdと再現手順を記録してください。認証コード・メールアドレス・token・生の認証ログは共有しないでください。未確定メッセージは秘密がないことを確認してからparser用fixtureへ追加します。
