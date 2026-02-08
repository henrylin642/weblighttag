產品名稱：Antigravity Optical ID Reader
版本：v1.0
目標：在免安裝（Web）條件下，透過手機相機讀取 LED 光學編碼，穩定解析 96-bit 資料並取得 16-bit 核心 ID。

⸻

1. 背景與問題定義

設備透過 3 顆 LED 以時間序列方式廣播資料。
完整資料長度 96 bit，分佈於 32 個 frame（每 frame 3 bit）。

由於發光採用人眼不可見的調變策略，必須依賴相機在特定拍攝條件下才能正確取樣。

市場需求要求：
	•	使用者不可安裝 App
	•	必須透過瀏覽器完成讀取與解析
	•	讀取時間需在可接受範圍（< 3 秒）
	•	成功率需可量產（> 95% in supported devices）

⸻

2. 產品目標（Goals）

必達
	•	成功取得 16-bit ID
	•	Web 端完成全流程
	•	自動完成幀同步與校驗
	•	對使用者無需理解曝光/相機術語

非目標（v1 不處理）
	•	任意手機全面兼容
	•	在所有 AE / HDR 開啟情況下保證成功
	•	背景強光極端場景

⸻

3. 使用流程（User Journey）
	1.	使用者打開網頁
	2.	允許相機權限
	3.	系統自動檢測設備能力
	4.	若支持 → 進入讀取
	5.	若不支持 → 給出明確提示
	6.	1~3 秒內返回 ID
	7.	進行後續業務流程

⸻

4. 系統總覽（High Level）
LED 發送端
    ↓ 光學
相機 Sensor
    ↓
Browser MediaStream
    ↓
Frame Grabber
    ↓
LED ROI Extractor
    ↓
Threshold / Symbol Decode
    ↓
Preamble Sync
    ↓
Packet Builder (32 frames)
    ↓
CRC / ID Validate
    ↓
Output ID


⸻

5. 功能需求

⸻

5.1 相機能力管理（最關鍵）

FR-1：能力探測
系統需讀取：
	•	frameRate range
	•	exposureMode / exposureTime
	•	iso / gain
	•	focusMode

FR-2：條件判定
若無法接近以下條件，需提示設備不支持：
	•	fps ≈ 25
	•	exposure 可接近短曝光（~1/50）
	•	可穩定輸出連續影像

FR-3：參數嘗試鎖定
若支持 manual，嘗試設置：
	•	frameRate = 25
	•	exposure ≈ 1/49
	•	ISO ≈ 750

並讀回 settings 驗證。

⸻

5.2 LED 偵測

FR-4：ROI 初始化
自動或半自動定位三顆 LED。

FR-5：亮度提取
每 frame 需取得三個 ROI 的亮度值。

⸻

5.3 Symbol 解碼

FR-6：自適應門檻
每顆 LED 需獨立 threshold，避免環境光與 AE 漂移。

FR-7：生成 symbol
每 frame 產生 3bit → 0~7。

⸻

5.4 幀同步

FR-8：Preamble 搜尋
使用滑動窗口從連續 frame 中定位封包起點。

FR-9：允許丟幀
系統需能在短暫錯位後重新同步。

⸻

5.5 封包與驗證

FR-10：收集 32 frames
FR-11：生成 96 bit
FR-12：CRC 驗證
FR-13：抽取 16-bit ID
FR-14：若 CRC fail → 丟棄並等待下一輪

⸻

5.6 輸出

FR-15：
在成功後 100ms 內輸出 ID。

⸻

6. 性能需求（KPI）
指標  |  目標
首次成功時間 | ≤ 3 秒
支持設備成功率 | ≥ 95%
解碼延遲 | ≤ 1 packet
CPU 使用 | 可在中端手機即時運行

7. 相機約束（現實）

iOS

幾乎不可鎖 exposure / ISO。
需依賴 decoder 容錯。

Android

部分機型可透過 constraints 接近鎖定，但必須逐機型驗證。

⸻

8. 風險（必須讓管理層看到）

R1

Web 對底層 ISP 控制不足，成功率會隨手機差異波動。

R2

HDR / multi-frame NR 可能抹平調變。

R3

fps 可能被 thermal policy 改變。

R4

rolling shutter 行為各家不同。

⸻

9. 風險緩解策略
	•	重複廣播
	•	強 preamble
	•	ID 多次一致性
	•	快速重試
	•	設備白名單

⸻

10. 量產前必須完成
	•	Top N 手機兼容測試
	•	每機型能力表
	•	AE 漂移測試
	•	成功率統計

⸻

11. 成功定義（Launch Gate）

若：
	•	支持機型成功率 ≥ 95%
	•	平均讀取 ≤ 3 秒
則可進入量產。

⸻

12. 未來演進方向（v2）
	•	改為不依賴固定 exposure 的編碼
	•	使用頻域或 rolling shutter 特徵
	•	提升 Web 普適性
