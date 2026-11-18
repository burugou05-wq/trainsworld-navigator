# Trainsworld Navigator

[English documentation](README.en.md)

**Trainsworld のセーブから、自分で作った鉄道網の乗換を検索。**

ブラウザーゲーム [Trainsworld](https://anita.garden/trainsworld/) 向けの非公式ルートプランナーです。ゲーム内の駅・路線・停車順を使い、出発・到着時刻を指定して検索できます。Web版と Chrome・Firefox のサイドバー版があります。

A local-first route planner for **Trainsworld** save files, with time-aware routing, railway maps, and side-by-side save comparisons.

## 主な機能

- **時刻指定の乗換案内** — 駅名の入力補完、出発・到着時刻指定、所要時間・乗換回数順。対応する運賃設定があれば円表示と運賃順も利用できます。
- **路線図と停車駅比較** — 検索経路を路線図で強調し、快速・各停・支線の停車順を比較できます。乗換ごとのホーム名も確認できます。
- **セーブの比較** — 同じ時刻・検索条件で新旧の経路を比較し、所要時間、乗換回数、利用系統の変化を確認できます。
- **ブラウザー内で処理** — セーブの読み込み、検索、保存は端末内で完結します。

## Web 版

1. Node.js 22 以上が使えるターミナルで、このフォルダーを開きます。
2. `npm start` を実行し、ブラウザーで [http://127.0.0.1:4173/](http://127.0.0.1:4173/) を開きます。
3. 「セーブを読み込む」からファイルを選びます。画面へのドラッグ＆ドロップでも読み込めます。
4. 出発駅・到着駅を入力し、候補を選択して「経路を検索」を押します。候補は上下キーと Enter でも選択できます。
5. 「駅・路線」で停車駅・乗換系統を確認できます。「路線図」ではクリックで駅や路線を選べます。ドラッグで移動し、ホイールかボタンで拡大・縮小できます。

ヘッダーの「日本語 / English」から画面の言語を切り替えられます。駅名・系統名はセーブに記録された表記で表示します。

検索結果の「構内乗換」を開くと、到着・乗車それぞれの系統、セーブ上のホーム名、ホームIDが表示されます。候補を切り替えると、乗車・待ち・構内移動の内訳と他候補との差を確認できます。「駅・路線」の路線グループでは、同じグループの系統ごとに停車順・通過を比較できます。狭い画面では表を横にスクロールできます。

ゲームから新しいセーブが出たら再び読み込んでください。「セーブ管理」で取り込み済みのファイルを切り替えられます。各ファイルのコピーはブラウザーに保管されます。「取り除く」はこのコピーを削除します。

ゲームで乗換駅のペンボタンから一括改名した場合も、新しいセーブを取り込むと名称が反映されます。駅名の末尾の「駅」は省略して検索できます。離れた同名の駅は、候補で駅IDと系統を確認して選択してください。

ゲームのファイルは「Saved games」の対象セーブにあるダウンロード操作（英語表示では「Download as a file」）で保存できます。[Trainsworld](https://anita.garden/trainsworld/)

## 拡張版

[GitHub Releases](https://github.com/burugou05-wq/trainsworld-navigator/releases/latest) から対象ブラウザーの ZIP をダウンロードして展開するか、下記の手順でビルドしてください。

`npm run build` で `dist/web`、`dist/chrome`、`dist/firefox` を作成します。外部パッケージのインストールは不要です。Web のビルド出力は `node scripts/serve.mjs --dist` でも確認できます。

- **Chrome**（116 以上）で `chrome://extensions` を開き、「デベロッパー モード」を有効にします。「パッケージ化されていない拡張機能を読み込む」で `dist/chrome` を選択します。ゲームのタブを開いたまま、拡張機能メニューから Trainsworld Navigator を選びます。
- **Firefox** で `about:debugging#/runtime/this-firefox` を開き、「一時的なアドオンを読み込む」で `dist/firefox/manifest.json` を選択します。拡張機能のボタンまたはブラウザーのサイドバーで開閉します。一時的な読み込みは Firefox の再起動まで有効です。常設版には Mozilla の署名が必要です。 [Firefox Extension Workshop](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)

幅はブラウザーのサイドバー境界で調整できます。セーブは各版で手動インポートします。ゲームとの自動同期には対応していません。Chrome は `sidePanel` の権限を使用します。Firefox はサイドバー宣言を使用します。 [Chrome Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) · [Firefox sidebar_action](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sidebar_action)

## ゲーム計算値で所要時間を比較する

対応するセーブから、公式ゲームが計算する方向別・需要帯別の駅間時間、停車時間、距離を付けたファイルを作れます。通常のセーブと同じ操作で `.twtime` を読み込んでください。

```powershell
node scripts/timing.mjs "C:\path\to\world.save" "world.twtime"
```

このコマンドは照合済みのゲーム公開ファイルを取得してローカルで実行します。セーブの外部送信や上書きは行いません。停車順と線路経路を照合できる系統に計算値を付けます。環状線と照合できなかった系統は通常の推定を使います。需要帯の境界では、各需要帯の計算値から残りの区間時間を補間します。待ち時間・構内移動時間・個々の発着時刻は引き続き推定です。

## セーブをまたいで比較

比較するセーブを両方読み込み、いつも通り経路を検索してください。結果の「別のセーブと経路を比較」でファイルを選ぶと、同じゲーム内時刻・検索条件で両方の第1候補を表示します。路線名を開くと停車順も確認できます。比較する駅はID・位置・名前で照合し、必要に応じて比較先で指定し直せます。ゲーム計算値の有無が揃わない場合は、両方を同じ推定で計算します。

## 検索条件

- **早い順**は、出発指定では到着の早さ、到着指定では指定時刻までに着ける出発の遅さを比較します。ゲーム内時刻で06:00〜20:00は高需要、20:00〜24:00は中需要、00:00〜06:00は低需要です。待機中に時間帯が変わると運行頻度も切り替わり、運行がない区間では再開まで待機します。表示する時刻は運行頻度に基づく推定です。
- **乗換が少ない順**は、乗換回数を優先し、同じ回数なら時間を比較します。
- **安い順**は、このセーブで確認できた距離運賃の条件を満たす場合に使えます。保存された料金曲線を推定乗車距離に適用します。画面上の金額はゲーム内の換算（1ドル＝150円）で円表示します。 [Trainsworldの通貨設定](https://anita.garden/trainsworld/assets/StartLogo-CQSIyI1Z.js)
- 所要時間に発着駅内でのアクセス時間や混雑による遅れは含まれません。異なるホーム間の乗換には3分、同じホームでの乗換には2分を見込みます。時刻表ベースの発着時刻表示はありません。

## 抽出・テスト

```powershell
npm run extract -- "C:\path\to\world.save"
npm run extract -- "C:\path\to\world.save" 0 501
npm test
$env:NAVIGATOR_TEST_SAVE = "C:\path\to\trainsworld-tokyo-2-day-195.save"
$env:NAVIGATOR_TEST_SAVE_204 = "C:\path\to\trainsworld-tokyo-2-day-204.save"
npm test
```

抽出結果は端末に JSON で出力されます。Windows PowerShell で UTF-8 のファイルに保存するには、抽出コマンドの後ろに `| Set-Content -Encoding utf8 network.json` を追加します。駅IDの指定は任意です。

- [公式情報と解析調査](docs/research.md)
- [セーブ形式の仕様](docs/save-format.md)
- [検証レポート](docs/verification.md)

実装は `src/save.mjs`（読み込み）、`src/router.mjs`（探索）、`src/app.mjs`（画面）、`src/map.mjs`（路線図）、`src/storage.mjs`（保存）で構成されています。

対応形式は `TWG1` の `TWT4〜TWT6`。検証済みの鉄道とフェリーを検索できます。バスは記録された系統名と道路経路を読み込めますが、ゲームが道路データから生成する停留所は未復元のため検索対象外です。未確認のバイナリ設定は駅IDまたは追加領域名を表示して通知します。 [対応範囲と検証](docs/compatibility.md)
