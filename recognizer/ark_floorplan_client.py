# -*- coding: utf-8 -*-
"""
豆包大模型户型图识别客户端（已在 doubao-seed-evolving / plan-v3 网关上验证可用）

用法：
  set ARK_API_KEY=ark-xxxx
  python ark_floorplan_client.py 户型图.png 输出.json [--thinking]

注意：
  1. 该 key 只能走 /api/plan/v3 网关，标准 /api/v3 会 401；
  2. 生产默认 thinking=off（约 15~25s），复杂图可加 --thinking 精修（约 3~4 分钟）；
  3. response_format 用 json_object（保证合法 JSON）；
     不要用 json_schema 强约束——实测该网关下会导致门窗过分割；
  4. 返回坐标为 0~1000 各轴独立归一化，需要后处理：端点吸附、共线合并、
     直角化、门窗挂接到最近墙、用 dimensions 解算毫米比例尺。
"""
import base64, json, os, sys, time, argparse, urllib.request, urllib.error

API_URL = "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions"
MODEL = "doubao-seed-evolving"

PROMPT = """识别这张中国住宅户型平面图（黑色填充为墙体）。只输出 JSON 对象，不要 markdown、不要解释。
坐标归一化到 0-1000：图片左上角为(0,0)，右下角为(1000,1000)，x/y 两轴各自独立归一化。
每道墙用单根中心线表示，在交点处断开闭合。
严格按此结构输出：
{"walls":[{"id":"w1","from":[x,y],"to":[x,y],"thicknessMm":200,"loadBearing":true}],
"doors":[{"id":"d1","wallId":"w1","at":[x,y],"widthMm":900,"kind":"swing","hingeSide":"left","opensInward":true}],
"windows":[{"id":"win1","wallId":"w1","from":[x,y],"to":[x,y],"kind":"normal","sillMm":900}],
"rooms":[{"id":"r1","name":"","type":"living_room","polygon":[[x,y]]}],
"dimensions":[{"text":"9000","from":[x,y],"to":[x,y]}],
"entranceDoorId":"d1","northDirectionDeg":0,"notes":""}

规则：
1. walls 覆盖全部外墙与内墙，外墙 thicknessMm=200 且 loadBearing=true，内墙 100；
2. 门只数真实门洞：平开门(有门弧) kind=swing，推拉门(平行双线) kind=sliding，折叠门 folding；
   hingeSide 为合页所在侧(left/right)，opensInward 表示是否向房间内开；
3. 窗只数窗洞：普通 normal、飘窗 bay、落地窗 floor；sillMm 默认 900；
4. 房间 type 取值 living_room/dining_room/bedroom/kitchen/bathroom/balcony/study/other，name 用图中文字；
5. dimensions 照抄图中尺寸数字，from/to 为该尺寸界线两端；
6. 不确定的元素不要编造，写入 notes。"""


def recognize(image_path: str, api_key: str, thinking: bool = False, timeout: int = 300) -> dict:
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    ext = "png" if image_path.lower().endswith(".png") else "jpeg"
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:image/{ext};base64,{b64}"}},
        ]}],
        "max_tokens": 6000,
        "temperature": 0.1,
        "stream": True,
        "thinking": {"type": "enabled" if thinking else "disabled"},
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
    t0 = time.time()
    parts, reasoning = [], 0
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            p = line[5:].strip()
            if p == "[DONE]":
                break
            try:
                ch = json.loads(p)
            except json.JSONDecodeError:
                continue
            delta = ch.get("choices", [{}])[0].get("delta", {})
            if delta.get("reasoning_content"):
                reasoning += len(delta["reasoning_content"])
            if delta.get("content"):
                parts.append(delta["content"])
    text = "".join(parts).strip()
    # 容错：去掉可能的 ```json 包裹
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{"):text.rfind("}") + 1]
    result = json.loads(text)
    result["_meta"] = {"elapsedSec": round(time.time() - t0, 1),
                       "reasoningChars": reasoning, "model": MODEL, "thinking": thinking}
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("out", nargs="?", default="floorplan.json")
    ap.add_argument("--thinking", action="store_true", help="开启思维链精修（慢，约3~4分钟）")
    args = ap.parse_args()
    key = os.environ.get("ARK_API_KEY")
    if not key:
        sys.exit("请先设置环境变量 ARK_API_KEY")
    try:
        r = recognize(args.image, key, thinking=args.thinking)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode('utf-8')[:500]}")
    json.dump(r, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    m = r["_meta"]
    print(f"完成，耗时 {m['elapsedSec']}s（thinking={m['thinking']}）")
    print(f"墙 {len(r.get('walls', []))} / 门 {len(r.get('doors', []))} / "
          f"窗 {len(r.get('windows', []))} / 房间 {len(r.get('rooms', []))} / "
          f"尺寸 {len(r.get('dimensions', []))}")
    print(f"已保存: {args.out}")
