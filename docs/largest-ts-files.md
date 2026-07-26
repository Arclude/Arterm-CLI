# Projedeki en büyük TypeScript dosyaları

Aşağıda, `node_modules` ve `dist` hariç projedeki tüm `.ts` dosyaları arasından
**satır sayısına göre en büyük 3 tanesi** ele alınmıştır (test dosyaları hariç,
yani asıl kaynak dosyalar). Her biri için dosyanın ne işe yaradığı bir
paragrafla açıklanmıştır.

## 1. `packages/core/src/autonomy.ts` — 920 satır

Bu dosya, ajanı bir hedefe doğru **otonom olarak** yürüten `AutonomyEngine`
sınıfını içerir; döngüsü "karar ver → uygula → değerlendir → tekrarla"
şeklindedir. Motor birden fazla çalışma kipini destekler: tek bir ajanın adım
adım ilerlediği `once`/`eternal`; hedefi bağımsız alt görevlere bölüp bunları
eşzamanlı bir alt-ajan filosuna dağıtan `parallel`; işi sıralı fazlara (plan →
uygula → doğrula) bölen `phased`; ve her turda uzman "üyelere" görev atayan,
paylaşılan bir blackboard ve üye hafızası kullanan `team` kipi. Ayrıca
tamamlanmayı güvenilir biçimde tespit etmek için enjekte edilen `task_done`
aracını, bağımsız bir "verifier" ile taze bağlamda tamamlama denetimini,
checkpoint (çökme kurtarma) desteğini ve steer / pause / resume / stop yaşam
döngüsü kontrollerini barındırır.

## 2. `packages/cli/src/main.ts` — 870 satır

Bu dosya, `arterm` ikili dosyasının **giriş noktası** ve komut satırı
yönlendirmesidir; commander ile tüm alt komutları (`chat`, `init`, `models`,
`pull`, `sessions`, `login`/`logout`, `auth`, `memory`, `status`, `mcp`) ve
küresel bayrakları (`--provider`, `--model`, `--yolo`, `--goal`, `--print`,
`--resume`, `--status-port` vb.) tanımlar. Etkileşimli TUI oturumunu başlatan
`startChat`, betikleme/CI için TUI'siz tek seferlik çalıştırmayı yapan
`runHeadlessFlow`, sağlayıcı ön-kontrolü (`preflight`), oturum devam ettirme
(resume) ve otonom çalışma için çökme-kurtarma checkpoint mantığı burada
kurgulanır. MCP sunucuları, eklentiler (plugins), yetenekler (skills) ve ajan
tanımları gibi dış yetenekleri yükleyip her oturuma iliştiren `enrichSession`
fabrikası ile desktop durum sunucusunun (status server) başlatılması da bu
dosyada yer alır.

## 3. `packages/core/src/agent.ts` — 790 satır

Bu dosya, konuşmayı sürükleyen çekirdek `Agent` sınıfını içerir: model çıktısını
akış (stream) hâlinde toplar, araç çağrılarını (izinlerle geçitlenmiş biçimde)
çalıştırır ve sonuçları modele geri besleyerek nihai yanıt üretilene dek döngüyü
sürdürür. Döngünün davranışı doğrudan `run()` içinde değil, kernel üzerindeki
**adlandırılmış middleware "pipeline" aşamaları** (`userInput`, `request`,
`response`, `assistantOutput`, `toolCall`, `contextWindow`) olarak kurgulanır;
`installDefaultPipelines()` bunların varsayılan davranışlarını kurar (izin
denetimi, araç yürütme, döngü koruması/loop-guard, sistem istemi oluşturma,
metinden JSON araç çağrısı kurtarma vb.). Ayrıca sistem istemini ortam bilgisi +
proje talimatları (CLAUDE.md/AGENTS.md) + yetenekler + hafıza ile inşa etme,
bağlam penceresi dolunca otomatik sıkıştırma (auto-compaction) ve eski araç
sonuçlarını temizleme, otonom motorun kullandığı `assess()`/`plan()` sondaları
ve `RunController` ile turun iptal/temizlik yaşam döngüsü yönetimi burada
bulunur.

## Özet tablosu

| # | Dosya | Satır | Paket | Kısaca ne işe yarar |
|---|-------|------:|-------|---------------------|
| 1 | `packages/core/src/autonomy.ts` | 920 | `@arterm/core` | Hedefe doğru otonom döngüyü (once/eternal/parallel/phased/team) yürüten `AutonomyEngine`; alt-ajan filosu, doğrulama ve checkpoint yönetimi. |
| 2 | `packages/cli/src/main.ts` | 870 | `@arterm/cli` | `arterm` CLI giriş noktası; commander komutları, TUI/headless başlatma, oturum devamı, sağlayıcı ön-kontrolü ve dış yeteneklerin bağlanması. |
| 3 | `packages/core/src/agent.ts` | 790 | `@arterm/core` | Konuşma/araç döngüsünü pipeline middleware'leriyle sürükleyen çekirdek `Agent`; izin geçitleme, sistem istemi, bağlam sıkıştırma. |

> Not: Sıralamada test dosyaları (`*.test.ts`) hariç tutulmuştur. Testler dâhil
> edilseydi `autonomy.test.ts` (778) ve `agent.test.ts` (728) de üst sıralarda
> yer alırdı.
