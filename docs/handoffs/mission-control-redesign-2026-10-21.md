# Handoff: Mission control redesign — berhenti di 15/24 WP

Tanggal: 21 Oktober 2026, Asia/Jakarta.

## Titik berhenti dan instruksi utama

User meminta: **selesaikan sampai 15 WP, lalu buat dokumen handoff untuk agent lain**. Target itu tercapai. Jangan menganggap seluruh redesign selesai atau mulai paket baru sebelum user meminta melanjutkan.

**15/24 = 62,5% berdasarkan jumlah paket yang sudah diverifikasi independen dan diintegrasikan. Ini bukan estimasi persentase waktu/effort.** Ada follow-up lintas kontrak pada paket yang sudah dihitung; itu tidak menjadi paket selesai tambahan.

Repo: `/Users/Panca/Documents/MyBook/Project/legos-factory`

Urutan bacaan untuk agent penerus:

1. Dokumen ini.
2. Instruksi AGENTS yang diberikan user; padanannya ada di `/Users/Panca/.codex/AGENTS.md`. Pada checkpoint ini **CLAUDE.md dan AGENTS.md lokal repo tidak ada**. User secara eksplisit mengizinkan AGENTS tersebut sebagai pengganti CLAUDE.md.
3. `docs/specs/mission-control-redesign.md` secara lengkap.
4. `docs/specs/mission-control-orchestration.md` secara lengkap, terutama **Orchestrator prompt**, **Pull requests and branches**, dan aturan worker. Playbook terbaru menambahkan WP-12/WP-13 dan backfill WP-33.

Peran: orchestrator **tidak menulis product code**. Delegasikan satu WP per worker, worktree dan branch sendiri, maksimum K=4 worker. Harness sesi ini menyediakan empat slot termasuk orchestrator, sehingga praktiknya maksimal tiga worker bersamaan. Tidak ada worker aktif tersisa pada handoff.

**Jangan sentuh `~/.legos-factory`.** Jangan merge PR berikutnya tanpa instruksi human baru. User hanya telah mengizinkan dan kami telah melakukan merge PR 1. PR 2 belum mendapat izin merge.

## PR dan integration branch

| PR milestone | Branch | Status | Product checkpoint |
|---|---|---|---|
| PR 1 contract | `mc/pr1-contract` | GitHub PR #12 sudah merged ke main | merge `69954ae0f0646665562651a858cb03b277d2777d` |
| PR 2 auto mode | `mc/pr2-automode` | GitHub PR #13 OPEN, menunggu human | `4f3f314139112fc4136e327962fe588f2192ae71` |
| PR 3 pipeline | `mc/pr3-pipeline` | Lokal, belum dibuka sebagai PR; stacked di PR 2 | product head `a3946c9a8287dcf9208f8e1fcbabbb77fae301fb` |
| PR 4 frontend | `mc/pr4-frontend` | Lokal, belum dibuka sebagai PR; cut dari main sesudah PR 1 | `63bc8bec1696083a2073e23973467663835fee3c` |

- [PR #12: contract](https://github.com/panca1093/legos-factory/pull/12)
- [PR #13: auto mode](https://github.com/panca1093/legos-factory/pull/13)
- `main` lokal pada checkpoint: `69954ae0f0646665562651a858cb03b277d2777d`.
- PR 2 live head/state diverifikasi saat handoff: OPEN, base main, head `4f3f314`, merge state CLEAN. Refresh lagi sebelum verdict/merge berikutnya.
- Handoff ini ditambahkan sebagai **commit dokumentasi saja** pada branch PR 3 sesudah product head di atas diverifikasi. Ambil SHA terbaru lewat `git rev-parse mc/pr3-pipeline`; source product tidak berubah oleh commit handoff.
- PR 3 sudah direbase dengan `--rebase-merges` ke head PR 2 yang selesai. Setelah human merge PR 2: refresh main, rebase PR 3 ke main, ubah base PR 3 menjadi main, lalu jalankan full checks.
- Urutan merge human tetap 1 → 2 → 3 → 4. PR 3 dan 4 belum layak dibuka sebagai selesai.

## Lima belas paket yang selesai dan diintegrasikan

| PR | WP | Hasil | Worker branch / final commit |
|---|---|---|---|
| 1 | WP-01 | Types dan default-only compatibility | `mc/wp-01` / `683aec1` |
| 1 | WP-02 | Kolom DB, fresh dan legacy migration tests | `mc/wp-02` / `ad1535a` |
| 1 | WP-03 | Automation settings storage dan endpoint awal | `mc/wp-03` / `a504f32` |
| 1 | WP-04 | Work item API shape dan tiga gate stub 501 | `mc/wp-04` / `744bff2` |
| 2 | WP-10 | Trimmed allowlist prefix, edit containment, pause, read-only precedence | `mc/wp-10` / `4f8cf9f` |
| 2 | WP-11 | Remember Bash prefix; owner-only persistence; decision ownership | `mc/wp-11` / `aba6469` |
| 2 | WP-12 | Owners, owner-only settings, auth/me isOwner | `mc/wp-12` / `8e53867` |
| 2 | WP-13 | Key-by-key defaults/errors dan atomic settings save | `mc/wp-13` / `8764113` |
| 3 | WP-30 | Parser, fallback sequential, dependency/touch-safe waves | `mc/wp-30` / `4044eb3` |
| 3 | WP-31 | Pure next/state machine, termasuk multi-repo spec regression | `mc/wp-31` / `0414f94` |
| 3 | WP-32 | Persona/model, metadata persistence, Inspector read-only | `mc/wp-32` / `8be49dc` |
| 3 | WP-34 | Routing grammar/matches, PUT validation, invalid stored-rule skip | `mc/wp-34` / `29826e8` |
| 4 | WP-20 | Shell, routes/redirects, API client awal, optional Me.isOwner | `mc/wp-20` / `c86030a` |
| 4 | WP-21 | Overview dengan actual decisions/work items/reviews | `mc/wp-21` / `02df66e` |
| 4 | WP-24 | Activity Mine/Team dan Sessions search/Open/Continue | `mc/wp-24` / `4bc0e04` |

WP-30 punya SHA worker lama yang bukan ancestor langsung integration branch karena rebase stack. **Isi `server/plan.ts` dan `test/plan.test.ts` sudah dibandingkan persis dan sama.** Jangan menyimpulkan pekerjaan belum terintegrasi hanya dari ahead/ancestor count.

## Verifikasi independen yang sudah dijalankan

Orchestrator membaca diff/scope, assertion test, commit messages dan data yang ditambahkan; menjalankan sendiri `npm test`, `npm run typecheck`, `npm run build` berurutan pada setiap worker selesai; lalu `npm test` setelah setiap merge `--no-ff` ke integration branch.

| Snapshot | Hasil final |
|---|---|
| PR 2 `4f3f314` | 20 test files, **187 tests passed**, typecheck passed, build passed |
| PR 3 product head `a3946c9` | 24 test files, **269 tests passed**, typecheck passed, build passed |
| PR 4 `63bc8be` | 18 test files, **170 tests passed**, typecheck passed, build passed |

WP-20 juga diverifikasi lewat browser oleh orchestrator: Overview, Work, Work item placeholder, Reviews, Activity, Settings, redirects `/tasks` → `/work`, `/sessions` → `/activity`, dan detail run/session tetap ada. Console errors kosong. **Halaman gabungan setelah WP-21/WP-24 belum diperiksa ulang secara visual**, dan Work/Work item masih placeholder di App sampai wiring lanjutan.

Ada episode load host 82 pada 11 logical CPUs yang menyebabkan timeout test lama. Run serial dengan temporary timeout lebih panjang dipakai hanya untuk diagnosis; **command `npm test` biasa kemudian kembali lulus tanpa override**, sebelum PR 1 di-merge. Tidak ada timeout/config test yang diubah untuk menutupi kegagalan.

## Sembilan paket yang belum selesai

| WP | Status nyata | Branch / checkpoint | Langkah berikut |
|---|---|---|---|
| WP-33 | Interim commit, **belum diverifikasi/diintegrasikan**, belum production-complete | `mc/wp-33` / `d323f489823336fde21ae09fac71a5ec25048374` | Rebase ke integration PR 3 yang kini punya WP-34; panggil route() sungguhan, Inspector reasons, full verification |
| WP-35 | Belum mulai | belum ada branch | Gate endpoints; user juga meminta Request changes yang berfungsi |
| WP-36 | Belum mulai | belum ada branch | Parallel builders; file overlap pipeline.ts berarti serial terhadap WP-35/WP-37 bila scope diperluas |
| WP-37 | Belum mulai | belum ada branch | Cataloger sesudah merge, off berarti skip |
| WP-22 | Preflight saja, branch bersih tanpa product changes | `mc/wp-22` / `3127387` | Work board + backend Team/My projects yang sudah diminta user |
| WP-23 | Worker commit ada, **belum diverifikasi/diintegrasikan**, belum wired ke App | `mc/wp-23` / `063962dd1216eb5e698939c45519b2395b605f3c` | Review/test independently, wire oleh pemilik App, aktifkan Brainstorm setelah kontrak siap |
| WP-25 | Preflight saja, branch bersih tanpa product changes | `mc/wp-25` / `3127387` | New task/ticket/Brainstorm sesuai keputusan user terakhir |
| WP-26 | Independent UI committed, **belum selesai/diintegrasikan** | `mc/wp-26` / `0b4e9c6055785adea37a317c7f05c58e1665a955` | Request changes masih disabled, menunggu API client dan backend |
| WP-27 | Belum mulai | belum ada branch | Automation settings UI; gunakan grammar routing yang disetujui di bawah |

Jangan menghitung WP-23/WP-26 sebagai selesai hanya karena worker melaporkan checks lulus. Mereka masih punya dependency/wiring yang nyata. Jangan merge interim WP-33 sebelum routing produksi aktif.

### Detail checkpoint WP-33

- Mengubah hanya `server/pipeline.ts`, `server/jira-sync.ts`, `server/work-items.ts`, `test/pipeline-wiring.test.ts`.
- Worker melaporkan 246 tests + typecheck/build passed pada interim commit; belum diulang oleh orchestrator.
- `approveSpec` diekspor untuk WP-35; startup/run hooks berada dalam `startSyncLoop` pada jira-sync.ts.
- Menjaga checkout hasil Builder untuk Inspector/retry, memproses setelah capturePr sebelum cleanup.
- Sudah ada regression awal: repo default building → shaping pada design run faktual; spec PR → spec_review; satu approval spec menaikkan semua repo eligible ke building; advanced repo tidak diregresikan.
- Legacy backfill sekali saat startup dan unreadable plan handling sudah ditulis; review assertion-nya sendiri.
- **Routing terkonfigurasi sengaja ditahan** sampai WP-34 tersedia. WP-34 kini sudah integrated, jadi ini wajib dihapus/diganti evaluasi route() nyata.
- Inspector persona memakai exact `Verdict: APPROVE | REQUEST_CHANGES | ABSTAIN`. Unknown/ABSTAIN bukan passing.
- Representasi minimal yang sudah disetujui orchestrator untuk reason tambahan: optional explicit nonempty `Human review: <reason>` lines; jangan menganggap seluruh free-text findings sebagai escalation reason. Persist reason yang terbaca manusia di note agar tidak hilang sebelum routing/tick/restart. **Bagian ini belum diimplementasikan setelah checkpoint**; worker dihentikan atas permintaan user.

### Detail checkpoint frontend yang belum terintegrasi

- WP-23 export: `WorkItem({ ticket, live })`. Pemilik WP-20 perlu import dari `./pages/WorkItem.tsx` dan mengganti placeholder dengan `<WorkItem ticket={decodeURIComponent(id)} live={live} />`.
- WP-22 boundary yang disepakati: `Work({ onStart: (ticket: JiraRow) => void })`. Jangan biarkan worker WP-22 mengedit App tanpa pembagian ownership baru.
- WP-26 mempertahankan export `Reviews`; tabs, actual gate filtering, Approve/error propagation, factory PR provenance (`impl` link dengan non-null `runId`), dan existing fix queue sudah dibuat. Required comment textarea sudah ada, tetapi Request changes masih disabled. API dependency belum dibuat.
- API client dan App/chrome dimiliki WP-20. Follow-up pemilik tersebut diperlukan agar halaman baru terhubung; komponen yang belum diimport tidak ikut Vite build sehingga build sukses saja tidak membuktikan layarnya bekerja.
- Temp frontend tests berada di `/tmp` agar tidak melanggar file lists; tidak ikut bundle. Red/green notes tercatat di laporan. Lakukan browser test dan regresi bermakna sendiri setelah wiring.

## Keputusan user yang sudah final — jangan ditanyakan ulang

### Otorisasi scope yang telah diberikan

- PR 1 sudah boleh dan telah di-merge. User memilih **PRs 2, 3, 4 berjalan paralel**, bukan PR 2 saja.
- WP-12 boleh mengubah satu baris `server/app.ts`: `settingsRoutes()` → `settingsRoutes(deps)`; sudah diterapkan.
- WP-30 `canRunTogether(a, b, plan)` boleh menerima argumen Plan ketiga; sudah diterapkan.
- Spec/implementation PR declined: **escalate ke human, stage tetap, tidak retry otomatis**; sudah ada regression WP-31.
- WP-32 boleh menambah task/persona request initialization di claude-runs.ts dan persistence di activity.ts + regression test; sudah diterapkan.
- Owner helper `isOwner(null)` mengembalikan false; route auth-off memakai `!users || isOwner(users.get(uid))`. Jangan mengubah auth-off menjadi non-owner karena env test tidak selalu mengisi LEGOS_AUTH.

### RoutingRule.value — kontrak persis dari user

Value tetap string. Entry dipisah koma, trimmed, case-insensitive; rule match jika salah satu entry match.

| Kind | Grammar / matching |
|---|---|
| paths | Repo-relative globs; `*` dalam satu segment, `**` any depth. Contoh `db/migrations/**, auth/**`; match terhadap changed files |
| lines | Satu positive integer N; match bila **added + deleted** seluruh PR **> N** |
| jira | Entry `type:<name>` atau `label:<name>`; match issue type atau salah satu label |
| repo | `workspace/slug`; `*` hanya di slug. Contoh `acme/api, acme/payments-*` |

Tidak ada negation atau regex. PUT settings harus 400 dan menyebut rule invalid. Rule invalid saat file dibaca harus diskip dan masuk automationErrors; valid sibling rules/settings tetap dipertahankan.

WP-34 sudah mengimplementasikan ini, termasuk perluasan scope `server/policy.ts` dan `test/automation-settings.test.ts` sesuai permintaan user. Export:

```ts
route(pr: { files: string[]; changedLines: number; repo: string;
  jiraType: string | null; labels: string[] }, rules: RoutingRule[],
  inspectorReasons: string[]): {
  toPerson: boolean;
  reasons: string[];
  matches: { id: string; reason: string }[];
}
routingRuleError(rule: Pick<RoutingRule, 'kind' | 'value'>): string | null
```

Contoh reason: `paths: db/migrations/0042_add_purpose.sql`. Inspector-only reason tidak membuat rule match palsu.

### Team board dan My projects — backend harus diperluas

User memilih **Extend backend scope for both controls**, bukan menonaktifkan kontrol.

Kondisi sekarang:

- GET `/api/work-items` hanya mengembalikan current uid, tidak ada owner identity pada WorkItem.
- `/api/team` adalah activity, bukan Team work board.
- Jira preset baru mine/sprint. Route sudah punya dukungan JQL, dan Workbench punya `jiraSearch`; My projects perlu definisi/query berdasarkan project→repo mapping yang ada.
- Jangan menyajikan Mine sebagai Team, dan jangan mengklaim disabled controls memenuhi keputusan user.
- Scope/file allocation perlu dicatat sebelum worker berikutnya; hindari overlap dengan WP-33/WP-35. Backend owner helper tersedia di PR 2/stack PR 3, belum pada base main PR 4. Jangan copy owner logic atau memasukkan ulang seluruh WP-12 ke PR 4.
- Rekomendasi lanjutan: backend dalam track PR 3 dengan perluasan file scope yang jelas, client/wiring oleh WP-20, halaman oleh WP-22. Tetapkan owner identity/read-only Team-detail contract dan authorization tests sebelum implementasi. User telah mengizinkan perluasan backend; jangan minta ulang izin fitur yang sama.
- Judul WorkItem belum tersedia. Gunakan Jira summary faktual bila ada; jangan mengarang dari PR title. Untuk local/unavailable, tampilkan unknown sampai kontrak benar tersedia.

### Brainstorm first — diskusi dulu, lalu spec

Jawaban terakhir user: **“Ya, diskusi dulu lalu spec.”**

Tracked chat harus tetap terkait ticket; tidak langsung menulis spec sampai user mengatakan lanjut. Server sekarang menambahkan spec-writing stage guide pada semua ticket run, termasuk chat, sehingga perlu follow-up WP-32 `launch-run.ts` dan dialog/defaults WP-25. Typed ticket defaults di `web/chrome.tsx` juga diperlukan; alokasikan ke pemilik WP-20 agar tidak diam-diam memperluas file list WP-25. Persetujuan user sudah jelas untuk perilaku diskusi-dulu; jangan tanyakan ulang keputusan produk yang sama.

**Belum diimplementasikan.** Jangan hanya melepas stage guide dan menganggap alur selesai: periksa transisi diskusi → spec, `RunManager.resumeTask` yang mensyaratkan `fromTask`, lifecycle chat yang tetap idle, dan capturePr yang berjalan saat run berakhir. Pastikan spec tetap ditemukan dan mencapai gate.

### Request changes — harus diimplementasikan, bukan disabled

User memilih **Define and implement it now**.

Alur yang sudah dikomunikasikan oleh orchestrator: komentar wajib; revisi spec kembali ke Foreman untuk spec PR yang sama lalu menunggu approval lagi; revisi implementation PR kembali ke Builder pada PR/branch yang sama, lalu Inspector. Tidak ada auto merge.

Kontrak endpoint/client yang telah dikoordinasikan ke worker WP-26 (masih belum dibuat):

- `POST /api/work-items/:ticket/request-spec-changes` dengan `{comment}`.
- `POST /api/work-items/:ticket/prs/:repo/request-changes` dengan `{comment}`.
- `api.requestSpecChanges(ticket, comment)` dan `api.requestPrChanges(ticket, repo, comment)`.

Alokasikan backend ke WP-35 dengan perluasan file scope yang diperlukan, API client ke pemilik WP-20, UI ke WP-26. Perilaku task selection/retry counter pada human revisions belum dikodekan; tentukan jelas dan uji tanpa mencampur otomatisasi merge. Jangan menganggap proposal endpoint berarti sudah ada.

## Risiko/gap yang diketahui

1. PR 2 mengikuti literal trimmed-prefix matching dari WP-10. Ia **belum mem-parse shell chains atau memvalidasi target git push**, sehingga belum membuktikan unconditional branch/deletion guards dalam desain umum. Risiko ini tertulis di body PR #13; putuskan kontrak sebelum menyebut seluruh security rule terpenuhi.
2. Escalated pada Overview memakai failed plan tasks, dihitung satu per work item. Declined PR escalation tanpa failed task belum punya typed API signal; jangan menebak dari attempt/free text.
3. Activity menampilkan shipped/gate-history totals sebagai `—` dengan penjelasan karena API belum punya histori tersebut. Jangan menampilkan angka sukses palsu.
4. Historical run task/persona, actors, Inspector findings dan matched-routing reasons belum semuanya diekspos ke frontend. WP-23/WP-26 menandai data yang tidak tersedia; metadata DB pada WP-32 sendiri sudah persisted.
5. Local ticket creation/key format belum diselesaikan; jangan menciptakan endpoint/ID policy diam-diam di New task.
6. Gate endpoints di main/PR 2 masih 501. WP-35 harus menggantinya berdasarkan fakta; merge runtime gunakan forge tool hanya jika tersedia, selain itu 409 + forge URL sesuai playbook.

## Workspace dan cleanup

| Tujuan | Path | Branch |
|---|---|---|
| Primary checkout | `/Users/Panca/Documents/MyBook/Project/legos-factory` | `mc/pr2-automode` |
| Pipeline integration + dokumen ini | `/Users/Panca/Documents/MyBook/Project/lf-pr3-integration` | `mc/pr3-pipeline` |
| Frontend integration | `/Users/Panca/Documents/MyBook/Project/lf-pr4-integration` | `mc/pr4-frontend` |
| Work board preflight | `../lf-wp-22` | `mc/wp-22` |
| Work item checkpoint | `../lf-wp-23` | `mc/wp-23` |
| New task preflight | `../lf-wp-25` | `mc/wp-25` |
| Reviews checkpoint | `../lf-wp-26` | `mc/wp-26` |
| Pipeline wiring checkpoint | `../lf-wp-33` | `mc/wp-33` |

Semua worker worktree paket selesai sudah dihapus, **branch tetap dipertahankan**. Worktree unfinished di atas dipertahankan bersih agar mudah dilanjutkan. Empat worktree `.claude/worktrees/*` yang sudah ada sebelum sesi ini adalah milik pekerjaan lain; jangan dihapus/diubah.

Server uji isolated pada port 4420/5320 sudah dihentikan setelah ownership PID/cwd diverifikasi. Tidak ada server task ini pada 4320/5220 saat cleanup.

Semua remaining worktree diverifikasi dengan `git status --porcelain --untracked-files=all` setelah handoff commit. Dependency symlink dan dist yang ignored bukan perubahan product.

## Cara memindahkan ke agent lain

Selain dokumen ini, disediakan **Git bundle** `mission-control-redesign-2026-10-21.bundle`. Bundle berisi main, semua integration branch dan worker branch `mc/*` checkpoint sesi ini, termasuk commit unfinished yang belum dipush. PR 3/4 dan worker checkpoint **belum ada di origin**; jangan mengira `git pull` saja mengambilnya.

Lokasi export sesi ini: `/Users/Panca/.codex/visualizations/2026/10/21/01a15d4a-5a46-75e2-b757-751c08795c27/`. Dokumen Markdown dan bundle ada bersama di folder tersebut. Salin keduanya bila pindah mesin.

Pada mesin/workspace lain, setelah file bundle dipindahkan:

```sh
git clone -b mc/pr3-pipeline /path/mission-control-redesign-2026-10-21.bundle legos-factory
cd legos-factory
git remote rename origin handoff
git remote add origin https://github.com/panca1093/legos-factory.git
git fetch handoff 'refs/heads/*:refs/remotes/handoff/*'
git branch mc/pr2-automode handoff/mc/pr2-automode
git branch mc/pr4-frontend handoff/mc/pr4-frontend
git branch mc/wp-33 handoff/mc/wp-33
```

Clone di atas sudah checkout `mc/pr3-pipeline`; branch lain dapat dibuat dari `handoff/<branch>` sesuai kebutuhan. Pada repo yang sudah ada, periksa branch lokal terlebih dahulu dan jangan pakai force untuk menimpa pekerjaan lokal. Bundle diverifikasi dengan `git bundle verify` pada handoff.

Contoh melanjutkan checkpoint WP-33 setelah user meminta lanjut:

```sh
git -C ../lf-wp-33 status --porcelain
git -C ../lf-wp-33 rebase mc/pr3-pipeline
```

Jangan cherry-pick WP-34 secara terpisah ke WP-33: routing sudah di integration base. Setelah rebase, diff WP-33 terhadap integration base harus hanya berisi file WP-33 yang disetujui.

## Verifikasi dan tooling untuk agent penerus

Setiap worker dan verifikasi orchestrator menggunakan storage terisolasi:

```sh
export LEGOS_DB=/tmp/lf-wp-XX.db
export LEGOS_SETTINGS=/tmp/lf-wp-XX-settings.json
export LEGOS_WORKSPACES=/tmp/lf-wp-XX-workspaces
export LEGOS_HUB_DB=/tmp/lf-wp-XX-hub.db
npm test
npm run typecheck
npm run build
```

Untuk app test: `LEGOS_AUTH=off`, isolated CLAUDE_PROJECTS_DIR, nonaktifkan integrasi nyata, port unik. **Vite proxy repo hard-coded ke API 4317**: bila API test memakai port lain, override proxy via temporary/programmatic Vite config; jangan mengakses service user di 4317.

Node pada sesi ini v26.0.0. Existing installed node_modules digunakan lewat symlink worker; dependency install baru tidak dibutuhkan di mesin ini. Sandbox memerlukan escalation untuk sibling worktree writes/commits dan loopback tests; jangan mengedit primary checkout untuk mengakali batas direktori.

Git HTTPS keychain helper default gagal pada push, sedangkan `gh auth` sesi user valid. Command-only helper berhasil tanpa mengubah config global:

```sh
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin <branch>
```

GitHub connector pernah 403 pada create PR; CLI authenticated berhasil. Buat body multiline memakai `--body-file`, lalu attach setiap PR ke chat melalui tool app. Tidak pernah tambahkan co-author/tool attribution. Jangan mengulang auth/login atau menampilkan token.

Setiap hasil worker harus diverifikasi sendiri: allowed files, nama dan assertion tests, tiga full checks, commit attribution, dan synthetic data. Jika satu check gagal, kirim exact failure ke worker yang sama sekali; kegagalan kedua berarti blocked untuk human. WP-31 sudah menggunakan satu fix round untuk bug multi-repo approval dan lulus setelah regression.

## Urutan resume yang disarankan

1. Pastikan user memang meminta melanjutkan setelah stop/handoff ini. Refresh PR #13 dan main; jangan merge PR #13 tanpa izin.
2. Resume WP-33 dari checkpoint setelah rebase ke PR 3; lengkapi route() nyata dan Inspector reasons; verifikasi lalu merge `--no-ff` ke PR 3.
3. Catat pembagian file untuk backend scope extensions yang telah diminta user, tanpa worker overlap. Implementasikan WP-35 termasuk Request changes dan scope backend Team/My projects yang disepakati pembagiannya.
4. Lanjutkan WP-36 dan WP-37 menurut dependencies/file ownership; pipeline.ts overlap berarti jangan menjalankannya bersamaan.
5. Lengkapi kontrak Brainstorm (server + typed defaults + dialog), client Request changes dan Work/WorkItem App wiring melalui pemilik file yang tepat. Jangan menghitung placeholder/disabled action sebagai selesai.
6. Resume WP-22/WP-25/WP-26, verifikasi WP-23, lalu WP-27; rebase worker bila dependency berubah. Uji semua screen terhadap data kontrak nyata dan periksa console/browser, termasuk owner/non-owner dan failure paths.
7. Saat masing-masing PR lengkap: full checks, push integration branch, buka PR dengan title playbook, attach, berhenti untuk human. PR 3 base tetap PR 2 sampai PR 2 merged; PR 4 target main. Bersihkan worktree task yang selesai dan pastikan semua perubahan committed sebelum handoff/final.
