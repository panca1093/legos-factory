# Handoff: Mission control redesign — selesai (24/24 work package)

Tanggal: 21 Oktober 2026, Asia/Jakarta.

Dokumen ini menggantikan `mission-control-redesign-2026-10-21.md` (yang berhenti di 15/24). Itu tetap di repo sebagai catatan kondisi perantara.

Repo: `/Users/Panca/Documents/MyBook/Project/legos-factory`
Spec: `docs/specs/mission-control-redesign.md`, `docs/specs/mission-control-orchestration.md`
Design (sumber kebenaran untuk tampilan dan kalimat): `docs/design/mission-control/*.dc.html`

## Status akhir

Semua work package sudah selesai, diverifikasi, dan di-merge ke branch integrasinya.

| PR | Branch | Base | Work package | Test | Status |
|---|---|---|---|---|---|
| 1 contract | `mc/pr1-contract` | main | WP-01…WP-04 | — | **merged** (PR #12) |
| 2 auto mode | `mc/pr2-automode` | main | WP-10…WP-13 | 187 | **PR #13 OPEN, menunggu human** |
| 3 pipeline | `mc/pr3-pipeline` | `mc/pr2-automode` | WP-30…WP-39 + 3 follow-up | 313 | **PR #14 OPEN** (stacked di #13) |
| 4 front end | `mc/pr4-frontend` | main | WP-20…WP-27 + 2 follow-up | 170 | **PR #15 OPEN** |

Urutan merge human tetap 1 → 2 → 3 → 4. **Jangan merge PR 3 atau PR 4 sebelum PR 2 di-merge.**

Setelah PR 2 di-merge:
1. `git fetch && git rebase mc/pr3-pipeline origin/main` (branch PR 3 sudah di-rebase dengan `--rebase-merges` ke head PR 2; setelah merge main, rebase lagi ke main).
2. Ubah base PR 3 jadi `main`.
3. Rebase `mc/pr4-frontend` ke `origin/main` **setelah PR 3 merged** — PR 4 memanggil endpoint yang lahir di PR 3.
4. Jalankan `npm test`, `npm run typecheck`, `npm run build` pada masing-masing branch sebelum merge.

## Work package yang ditambahkan di sesi ini

| Id | Isi | Alasan |
|---|---|---|
| WP-38 | `GET /api/team/work-items`, owners only, read-only | User memilih "extend backend scope" untuk Team board, bukan menonaktifkan kontrol |
| WP-39 | Percakapan tracked = diskusi; `POST /api/runs/:id/start-spec` | Keputusan user: "Ya, diskusi dulu lalu spec" |
| WP-39b | Chat tanpa folder dapat direktori scratch | Tanpa ini, tombol New chat di rail menjawab 400 |
| WP-39c | Chat scratch ditampilkan private di Sessions | Label share harus sama dengan share run-nya |
| WP-20b | Metode client: request changes, team board, startSpec, JQL | Tiga paket paralel butuh kontrak yang sama |
| WP-20c | Wiring App: Work, Work item, Merge, hapus halaman mati | `#/work` masih placeholder; Tasks.tsx dan Jira.tsx tidak diimpor siapa pun |

## Keputusan yang diambil orchestrator (bukan dari spec — baca sebelum mengubah)

1. **Satu PR per repo, bukan satu per task.** Awalnya setiap task membuka PR-nya sendiri, jadi repo dengan dua task dapat dua PR — bertentangan dengan keputusan 7 dan merusak routing (yang decides per repo). Sekarang setiap task punya branch dan workspace sendiri, dan satu merge run menggabungkan branch, menjalankan test suite, lalu membuka satu PR. `parallelBuilders` (0 = off) mengatur berapa task yang jalan bersamaan.
2. **Alasan routing disimpan di kolom baru** `work_items.routing` (JSON, nullable). Tabel `runs` hanya menyimpan activity item (tanpa teks hasil) dan `work_items.note` ditimpa setiap sync, jadi keduanya tidak bisa dipakai.
3. **Alasan Inspector hanya baris `Human review: <reason>`.** Free text lain adalah temuan, bukan alasan eskalasi.
4. **Revisi manusia tidak menyentuh penghitung attempt** dan tidak pernah eskalasi sendiri; eskalasi milik loop review agent tanpa pengawasan.
5. **Merge tool dicek lewat MCP `tools/list`.** Kalau tidak ada, jawabannya `409 {"error":"merge in the forge","url":…}` — jalan aman adalah default, karena permukaan merge workbench belum terverifikasi.
6. **Branch task harus di-push** oleh Builder. Inspector biasanya memakai workspace Builder; setelah restart ia meng-clone branch itu, dan clone gagal kalau branch belum pernah di-push.
7. **Revisi spec menunggu Foreman.** Tick memindahkan `shaping` → `spec_review` hanya kalau tidak ada run Foreman yang masih jalan untuk repo itu.

## Risiko dan gap yang masih terbuka

1. PR #13 memakai pencocokan prefix allowlist secara literal. Ia **tidak** mengurai shell chain dan tidak memvalidasi target `git push`, jadi guard branch dan delete dalam desain umum belum terbukti.
2. Merge tool workbench belum terverifikasi (lihat keputusan 5).
3. Branch task harus di-push (lihat keputusan 6).
4. Eskalasi PR declined memakai task plan yang gagal; declined PR tanpa task gagal belum punya sinyal bertipe.
5. Activity tetap menampilkan total shipped/gate sebagai `—` dengan penjelasan: API belum punya histori itu. Jangan menampilkan angka sukses palsu.
6. Histori run (persona, actor, temuan Inspector, alasan routing) belum semuanya terekspos ke front end; metadata DB sudah tersimpan.
7. Key format untuk local ticket belum diputuskan — jangan membuat endpoint atau kebijakan ID diam-diam.

## Verifikasi

- Tiap worker diverifikasi ulang oleh orchestrator: daftar file yang diizinkan, nama test, `npm test` + `npm run typecheck` + `npm run build`, atribusi commit, dan data sintetis. Test dijalankan ulang setelah tiap merge `--no-ff`.
- PR 3: server dijalankan dengan storage terisolasi dan endpoint baru dicoba lewat HTTP (team board, approve-spec, approve PR, merge, dua request-changes termasuk `400` untuk komentar kosong, start-spec) — semuanya menjawab dengan status dan pesan yang dimaksud.
- PR 4: build dicek jumlah modulenya (36 → 40) supaya halaman baru benar-benar masuk bundel; halaman yang tidak diimpor tidak ikut build, jadi build sukses tidak membuktikan apa pun. Aplikasi juga dijalankan di browser pada semua route termasuk redirect dan dialog New task.
- `~/.legos-factory` tidak pernah disentuh. Semua test memakai storage terisolasi (`LEGOS_DB`, `LEGOS_SETTINGS`, `LEGOS_WORKSPACES`).

## Workspace

| Path | Branch | Isi |
|---|---|---|
| `/Users/Panca/Documents/MyBook/Project/legos-factory` | `mc/handoff-20261021` | checkout utama (dokumentasi) |
| `/Users/Panca/Documents/MyBook/Project/lf-pr3-integration` | `mc/pr3-pipeline` | integrasi pipeline (PR #14) |
| `/Users/Panca/Documents/MyBook/Project/lf-pr4-integration` | `mc/pr4-frontend` | integrasi front end (PR #15) |

Worktree worker sudah dibersihkan setelah diverifikasi dan di-merge (semua bersih dan commit-nya sudah jadi ancestor integration branch). **Branch `mc/wp-*` tetap dipertahankan** — 31 checkpoint paket, jadi pekerjaan per paket bisa ditelusuri tanpa mengulang.
Empat worktree `.claude/worktrees/*` milik pekerjaan lain — jangan dihapus atau diubah.
