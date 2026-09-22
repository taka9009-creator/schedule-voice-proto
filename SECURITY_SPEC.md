# 音声スケジュール作成アプリ：セキュリティ＆基本設計書

作成方針：Viteや複雑なサーバーを使わず、シンプルなHTML/CSS/JSで制作しながら、**「GitHubやネットにそのまま公開しても絶対に漏洩・不正利用が起きない安全な設計」**を定義します。

---

## 1. 最重要セキュリティ原則：APIキーの保護

### なぜ初心者が危険なのか？
HTMLやJavaScriptに直接 `const API_KEY = "AIzaSy..."` と書いてGitHubやWeb上に公開すると、**公開から数秒〜数分で世界中のクローラー（自動巡回ボット）にキーを盗まれます**。その結果、他人にAPIを無制限に使われ、高額な請求が発生するトラブルが多発しています。

本設計では、サーバーを持たない静的HTMLサイトにおいて最も安全な**「BYOK方式（利用者入力方式）」**を採用します。

```
【危険な例（絶対NG）】
HTML / script.jsの中に直接APIキーを書く
  → 誰でも「右クリック → ソースを表示」でキーを盗める

【本設計で採用する安全な方式（BYOK方式）】
コードの中にはAPIキーを「1文字も書かない」
  → 利用者がアプリの画面上（設定モーダル等）で自分のキーを入力
  → 入力されたキーは「その人のブラウザ内（localStorage）」だけに保存
  → Web上にコードを丸ごと無料公開（GitHub Pages等）してもキー漏洩リスクはゼロ
```

---

## 2. 必須セキュリティ項目チェックリスト

ネット上に公開する前に、以下の4点を必ず満たす設計とします。

| No | 項目 | 対策内容 | 初心者が守るべきルール |
| :--- | :--- | :--- | :--- |
| **SEC-01** | **APIキーの非公開** | コード内にキーを埋め込まず、画面から設定させる。 | `.html` や `.js` に `AIzaSy...` などの文字列を絶対に書かない。 |
| **SEC-02** | **XSS（クロスサイトスクリプティング）防止** | 音声テキストや予定タイトルをHTMLに描画する際のエスケープ。 | JavaScriptで画面に文字を出す時は `innerHTML` を使わず、必ず `textContent` または `.value` を使う。 |
| **SEC-03** | **予定データのプライバシー保護** | スケジュール情報を外部サーバーへ無断送信しない。 | 予定データはブラウザの `localStorage` のみに保存し、外部データベースへは送らない。 |
| **SEC-04** | **APIキーのスコープ制限** | Google AI Studio（Gemini等）でキーを発行する際の設定。 | 万が一漏洩しても被害が出ないよう、無料枠（Free tier）のキーを利用し、クレジットカード連携を不要な段階では行わない。 |

---

## 3. 具体的な画面・コード設計（BYOK方式の実装イメージ）

### ① 画面上の「鍵（設定）ボタン」
画面の隅に控えめな「鍵アイコン（🔑）」を配置します。
* 初回起動時またはAI解析ボタンを押した際、キーが未設定であれば「Gemini APIキーの設定」モーダルを表示。
* 入力欄はパスワード形式（`type="password"`）にして画面の盗み見を防止。

### ② JavaScriptでの安全なキーの取り扱い
```javascript
// 1. キーの保存（ブラウザ内だけに留め、外部には一切送信しない）
function saveApiKey(key) {
  if (!key.startsWith("AIzaSy")) {
    alert("正しいGemini APIキーの形式ではありません");
    return;
  }
  localStorage.setItem("gemini_api_key", key.trim());
}

// 2. API呼び出し時のみ取り出して使用
function getApiKey() {
  return localStorage.getItem("gemini_api_key");
}

// 3. キーの削除（いつでもリセット可能にする）
function clearApiKey() {
  localStorage.removeItem("gemini_api_key");
}
```

### ③ 安全な描画（XSS防止）
音声認識で悪意ある文字列（例: `<script>alert(1)</script>`）が紛れ込んだり、ユーザーが記号を入力した場合でも無害化する書き方を徹底します。

```javascript
// ✕ 危険な書き方（HTMLタグとして解釈されてしまう）
// document.getElementById("title").innerHTML = userInput;

// ◯ 安全な書き方（純粋な文字列として画面に安全に表示される）
document.getElementById("title").textContent = userInput;
document.getElementById("fieldTitle").value = userInput;
```

---

## 4. 開発・公開フェーズにおける安全運用手順

1. **GitHubにアップロードする場合**:
   * リポジトリを「Public（公開）」にしても、コード内にキーが存在しないため完全に安全です。
   * READMEに「使い方：ご自身のGoogle Gemini APIキー（無料）を取得し、画面の設定から入力してください」と記載するだけで、誰でも安全に使えるポートフォリオ作品になります。

2. **Web公開（GitHub Pages / Netlify / Cloudflare Pages等）**:
   * HTMLファイルをアップロードするだけで、無料で安全なHTTPSサイトとして世界中に公開できます。
