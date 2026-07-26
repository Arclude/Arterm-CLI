# Arterm-CLI Kernel İncelemesi (`packages/core/src/kernel/`)

Bu belge kernel katmanının dört çekirdek dosyasını gerçek kod ve satır
referanslarıyla Türkçe açıklar: `container.ts`, `pipeline.ts`,
`runController.ts`, `tokens.ts`. Sonunda zayıf noktalar ve iyileştirme
fırsatları listelenir.

Genel resim: kernel, agent döngüsünün üzerinde çalıştığı minik bir DI + orta
katman (middleware) altyapısıdır. `buildSession` (bkz. `packages/cli/src/session.ts`)
kompozisyon köküdür; kök `Container`'ı kurar, servisleri token'lara bağlar ve
`Agent`'a verir. Token olmadan kurulan bir `Agent` (alt-ajanlar, testler)
dahili `defaultAgentContainer()`'a düşer (`packages/core/src/agent.ts:81-86`).

---

## 1) `tokens.ts` — Tipli DI token'ları

- **`Token<T>` arayüzü (`tokens.ts:13-18`)**: Kimlik `symbol`'dür; `T` yalnızca
  bir *phantom* markerdır (`readonly [TokenBrand]?: T`, satır 17). Çalışma
  zamanında hiç atanmaz, sadece `resolve<T>` çıkarımı için tip taşır → sıfır
  runtime maliyeti.
- **`token<T>(description)` (`tokens.ts:21-23`)**: `Symbol(description)` üretir.
  Aynı açıklamayla iki çağrı **farklı** token'lardır (symbol kimliği benzersiz).
- **`Tokens` tablosu (`tokens.ts:39-48`)**: Standart servis kümesi —
  `Logger`, `TokenCounter`, `SessionStore`, `PermissionPolicy`, `Compactor`,
  `Bus`, `Pipelines`, `RunController`. Yeni kod bunlar üzerinden resolve eder.
- Ek olarak `Logger` (`26-31`) ve `TokenCounter` (`34-36`) arayüzleri burada
  tanımlanır; kernel bunları bind edip decorate edebilir.

Not: `Logger` ve `SessionStore` token'ları tanımlı olsa da, `session.ts`
`Logger`'ı bind etmiyor (yalnızca Bus/PermissionPolicy/Compactor/Pipelines/
TokenCounter/RunController bağlanır, `session.ts:152-158`). Yani `Tokens.Logger`
şu an resolve edilirse "unbound token" fırlatır.

---

## 2) `container.ts` — Lazy, memoized tipli DI

`Container` üç Map tutar (`container.ts:13-15`):
- `factories: Map<symbol, Factory>` — kayıtlı üretici fonksiyonlar,
- `singletons: Map<symbol, unknown>` — ilk resolve'de önbelleğe alınan örnek,
- `decorators: Map<symbol, Decorator[]>` — resolve edilen değeri saran sarmalayıcılar.

Constructor bir opsiyonel `parent` alır (`container.ts:17`) → scope zinciri.

### `bind` (`container.ts:20-26`)
Factory kaydeder. Token **zaten bağlıysa** hata fırlatır
(`token already bound`, satır 21-23). Yani `bind` idempotent değildir; yeniden
bağlamak için `override` gerekir. Zincirlenebilir (`return this`).

### `override` (`container.ts:29-33`)
Bağlamayı **koşulsuz** değiştirir ve önbelleğe alınmış singleton'ı siler
(`singletons.delete`, satır 31). Testlerde ve `/login` benzeri servis
değişimlerinde kullanılır. `bind`'ten farkı: çakışmada hata vermez, cache'i
temizler.

### `decorate` (`container.ts:36-42`)
Token için bir sarmalayıcı listeye eklenir (`list.push`, satır 38) ve cache
düşürülür (satır 40). Örn. metering/tracing. Birden çok decorator sırayla
uygulanır (aşağıya bakın).

### `resolve` (`container.ts:45-58`)
1. Singleton cache'inde varsa onu döner (`45-46`).
2. Yerel factory yoksa **parent'a devreder** (`48-50`); parent da yoksa
   `unbound token` fırlatır.
3. Factory'yi çalıştırır (`52`), ardından bu container'daki decorator'ları
   **sırayla** uygular (`53-55`), sonucu cache'ler (`56`) ve döner.

Önemli semantik ayrıntı: decorator'lar `this.decorators.get(...)`'tan alınır —
yani **yalnızca değeri üreten container'ın decorator'ları** uygulanır. Değer
parent'tan resolve edilirse, çocuk scope'un decorator'ları **uygulanmaz**
(çünkü resolve parent'a devredilir ve parent kendi decorator listesini
kullanır). Bu, "scope'ta decorate et" beklentisi için ince bir tuzaktır
(bkz. zayıf noktalar).

### `has` (`container.ts:61-63`)
Token bu container'da **veya herhangi bir atada** bağlı mı? (parent zincirini
gezer).

### `createScope` (`container.ts:66-68`)
`new Container(this)` döner: bağlamaları miras alır ama **kendi singleton
cache'ine** sahiptir. Böylece bir run, bir servisi `override` edip kökü
kirletmeden değiştirebilir. Test bunu doğruluyor: scope inherit eder, kendi
override'ını cache'ler, kök değişmez (`kernel.test.ts:45-54`).

Kompozisyon kökü örneği (`session.ts:152-158`): `new Container()` kurulur,
altı-yedi servis bind edilir; dikkat: `RunController` **ayrı** bind edilir
(`session.ts:158`) çünkü factory'si container'ın kendisine referans verir
(`() => new RunController(container)`).

---

## 3) `pipeline.ts` — Koa tarzı isimli middleware zinciri

### `Middleware<Ctx>` (`pipeline.ts:4`)
`(ctx, next) => Promise<void>`. `next()` zincirin geri kalanını çalıştırır;
onion (soğan) modeli.

### `Pipeline<Ctx>` — `entries: Entry[]` (`pipeline.ts:16-17`)
Her `Entry` bir `{ name, mw }`. İsimle adreslenebilirlik, özelliklerin ana
kodu yeniden yazmadan araya girmesini sağlar.

- **`use(name, mw)` (`19-22`)**: Sona ekler, zincirlenebilir.
- **`before(name, mw)` (`24-30`)**: `name`'in bulunduğu indeksin **önüne**
  `splice` ile ekler; ismi `before:${name}` olur. Hedef yoksa sona ekler
  (`27`). Örn. Brain Arbiter, `toolCall` boru hattında `permission`'dan önce
  bu şekilde eklenir (`session.ts:226-234`).
- **`replace(name, mw)` (`32-37`)**: Aynı isimli girdiyi yerinde değiştirir;
  yoksa sona ekler.
- **`remove(name)` (`39-42`)**: İsimli girdileri filtreleyip atar.
- **`has(name)` (`44-46`)**: İsimli stage kayıtlı mı? Agent varsayılan
  stage'leri kurarken bunu koruma (guard) olarak kullanır:
  `if (!cw.has("autoCompact")) cw.use(...)` (`agent.ts:210`, ve diğerleri) →
  bir özellik/test aynı ismi önceden kaydettiyse varsayılan atlanır
  (override edilebilirlik).

### `run(ctx)` (`pipeline.ts:49-60`)
- İçsel `dispatch(idx)` özyinelemesi. `lastCalled` guard'ı ile bir stage
  `next()`'i **iki kez çağırırsa** hata fırlatır (`51-52`,
  `pipeline next() called multiple times`).
- Bir stage `next()`'i çağırmazsa zincir **kısa devre** olur; sonrasındaki
  stage'ler çalışmaz (test: `94-106`). Agent bunu `permission` stage'inde
  bilinçli kullanır: bilinmeyen araç veya reddedilen izin `next()` çağırmadan
  döner (`agent.ts:227-251`).
- Sonunda aynı `ctx`'i döner (mutable, paylaşımlı bağlam).

### Bağlam tipleri ve registry
- Her aşamaya özel Ctx arayüzleri: `UserInputCtx`, `RequestCtx`, `ResponseCtx`,
  `AssistantOutputCtx`, `ToolCallCtx`, `ContextWindowCtx` (`pipeline.ts:65-98`).
  `ToolCallCtx` cancellation için `signal?`, çözülen `tool?`, `output/isError`,
  ayrıca `diff?`/`path?` taşır (`80-92`).
- `PipelineRegistry` altı boru hattını toplar (`100-107`); `PIPELINE_NAMES`
  (`109-116`) ve `createPipelines()` (`119-128`) altı boş geçişli (pass-through)
  boru hattı üretir.

### Agent'ın kurduğu varsayılan stage'ler (`agent.ts:194-348`)
- `contextWindow`: `clearToolResults` → `autoCompact` (sıra önemli, `196-220`).
- `toolCall`: `permission` → `execute` → `loopGuard` (`223-302`).
- `userInput`: `record`; `request`: `buildSystem`; `response`:
  `recoverToolCalls`; `assistantOutput`: `record` (`304-347`).
Döngü `run()` içinde bu boru hatları sırayla `.run(...)` ile çağrılır
(`agent.ts:565-596`, `686`). CLAUDE.md'nin dediği gibi: davranışı değiştirmek
için `run()`'ı düzenleme, stage ekle/değiştir.

---

## 4) `runController.ts` — Turn yaşam döngüsü ve cancellation

### `RunHandle` arayüzü (`runController.ts:9-26`)
Bir run'ın: tek bir iptal `signal`'i (`11`), run'a özel `scope` container'ı
(`13`), teardown kaydı `onTeardown` (`15`), iterasyon üst sınırı
`iterationLimit`/`getIterationLimit` (`17-18`), özerk devam bayrağı
`shouldContinue`/`requestContinue` (`20-21`), `abort` (`23`) ve LIFO teardown
çalıştıran `finish` (`25`).

Kritik tasarım: `RunHandle` `AbortSignal`'i **sarar, değiştirmez** — böylece
mevcut tüm `signal?.aborted` kontrolleri değişmeden çalışır (docstring `6-7`).

### `RunController.begin()` (`runController.ts:31-72`)
Her çağrı taze bir kapanış (closure) tabanlı handle üretir:
- `new AbortController()` (`32`) → iptalin tek kaynağı.
- `this.root.createScope()` (`33`) → run'a özel çocuk container.
- Yerel durum: `teardowns[]`, `limit`, `cont`, `finished` (`34-37`).
- `abort(reason)` (`57-59`): yalnızca daha önce abort edilmemişse abort eder →
  **idempotent**.
- `finish()` (`60-70`): bir kez çalışır (`finished` guard, `61-62`);
  teardown'ları **LIFO** (ters) sırayla çalıştırır (`63-65`) ve her birini
  `try/catch` ile sarar → teardown **asla temiz kapanışı bloklamaz** (`66-68`).
  Test bunu doğruluyor: LIFO + idempotent (`kernel.test.ts:133-146`).

### Signal linking / cancellation mantığı (`agent.ts:539-637`)
`Agent.run(userInput, signal?)`:
1. `const handle = this.runController.begin()` (`548`), sonra
   `handle.iterationLimit(maxIterations)` (`549`).
2. **Dışsal sinyali linkler, doğrudan iş parçalarına geçirmez** (`552-556`):
   - `const onExternalAbort = () => handle.abort("external")`.
   - Çağıranın `signal`'i zaten abort ise handle hemen abort edilir (`554`);
     değilse `signal.addEventListener("abort", onExternalAbort, { once:true })`.
   - Böylece iptalin **tek doğruluk kaynağı** `handle.signal` olur; TUI Esc,
     autonomy pause/stop hepsi buraya akar, `run(input, signal?)` sözleşmesi
     değişmez.
3. Döngü boyunca `runSignal = handle.signal` kullanılır: her iterasyon başında
   `runSignal.aborted` kontrolü (`575-578`); araç çağrıları arasında da iptal
   olursa **her kaydedilmiş `tool_call` için bir tool sonucu** yine de yazılır
   (`607-610`) — aksi halde native sağlayıcı API'leri eşleşmeyen tool_call'ı
   reddeder.
4. `finally` (`633-637`): dışsal dinleyici sökülür (`removeEventListener`,
   `634`) ve `handle.finish()` çağrılır (`636`) → teardown olarak kayıtlı
   `turn_end` emit'i (`558`) LIFO çalışır.

`iterationLimit`/`getIterationLimit` (`agent.ts:549`, `568`) turn başına
iterasyon tavanını taşır. `shouldContinue`/`requestContinue` API'si tanımlı
ama şu an döngüde tüketilmiyor (bkz. zayıf noktalar).

---

## Zayıf noktalar ve iyileştirme fırsatları

1. **Scope decorator'ları uygulanmıyor.** `resolve` bir değeri parent'tan
   çözerken çocuk scope'un `decorate` çağrıları hiç uygulanmaz
   (`container.ts:45-58`, parent'a `return this.parent.resolve(tok)` ile
   devreder). Bir run, kök servisini decorate ederek trace/meter eklemek
   isterse sessizce etkisiz kalır. İyileştirme: resolve devrederken çocuğun
   decorator'larını da uygula ya da bu davranışı açıkça belgele.

2. **`override` çocuk-cache'i temizler ama parent-cache'i değil.** Doğru
   davranış (scope izolasyonu) ama parent zaten bir singleton ürettiyse ve
   çocuk sonradan override etmezse çocuk hep parent örneğini paylaşır — bazı
   "her run için taze örnek" beklentileri için sürpriz olabilir. Belgelenmesi
   yeterli olabilir.

3. **`shouldContinue`/`requestContinue` ölü API.** `RunHandle`'da tanımlı
   (`runController.ts:19-21`, `51-55`) ve testte var (`kernel.test.ts:148-157`)
   ama `agent.ts` döngüsü hiç tüketmiyor. Ya özerk devam mantığına bağlanmalı
   ya da şimdilik "gelecekteki kanca" olarak açıkça işaretlenmeli.

4. **`Tokens.Logger` / `Tokens.SessionStore` bağlanmıyor.** `session.ts`
   bunları bind etmiyor; resolve edilirse `unbound token` fırlatır. En azından
   no-op bir `Logger` bind edilmesi (decorate edilebilir bir seam olarak
   tanımlandığı için) tutarlılığı artırır.

5. **`Pipeline` eşzamanlılık/hata sözleşmesi.** `run` içinde bir stage'in
   `next()` sonrası atması zincirin `before`/sarmalayıcı davranışını etkiler;
   ayrıca `next()` çağrılmadığında sessiz kısa devre kasıtlıdır ama isimli
   stage'lerin bunu yapıp yapmadığı yalnızca konvansiyonla bilinir. Hata/iptal
   akışını Ctx üzerinden standartlaştırmak (örn. `ctx.aborted`) okunabilirliği
   artırır.

6. **`bind` çift-bağlama hatası vs. `override`.** İki API arasındaki fark
   (hata vs. sessiz değiştir) doğru ama çağrı yerlerinde kolayca karışabilir;
   kompozisyon kökünde `RunController`'ın ayrı bind edilme zorunluluğu
   (`session.ts:158`, self-referans) bir ayak-kapanı. Bir `bindLazySelf`
   yardımcı fonksiyonu bu deseni netleştirebilir.

7. **Teardown hataları yutuluyor.** `finish()` her teardown'u sessiz `catch`
   ile sarıyor (`runController.ts:66-68`). Temiz kapanış için doğru, ama en
   azından bir `Logger.warn` ile görünür kılmak hata ayıklamayı kolaylaştırır
   (Logger seam'i zaten mevcut).
