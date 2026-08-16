#!/usr/bin/env bash
# 对着本地 dev worker 跑一遍名单接口。用法：bash worker/test.sh [端口]
B="http://127.0.0.1:${1:-8813}"
TOK=test-token-1234567890
ORG='https://www.taolinwei.com'
ORG2='https://linwei94.github.io'
pass=0; fail=0
ck(){ if [[ "$3" == *"$2"* ]]; then echo "  PASS  $1"; pass=$((pass+1));
      else echo "  FAIL  $1"; echo "        期望包含: $2"; echo "        实际: $3"; fail=$((fail+1)); fi; }

# 三个接口全部要口令
post(){  curl -s -m 10 -X POST "$B/api/rsvp" -H 'Content-Type: text/plain;charset=UTF-8' \
         -H "x-admin-token: $TOK" -H "Origin: $ORG" -d "$1"; }
list(){  curl -s -m 10 "$B/api/list" -H "x-admin-token: $1" -H "Origin: $ORG"; }
plain(){ curl -s -m 10 "$B$1" -H "Origin: $ORG"; }   # 故意不带口令

echo "== 鉴权：三个接口都必须要口令 =="
ck "写入不带口令 -> 401"    '口令不正确' "$(curl -s -m 10 -X POST "$B/api/rsvp" -H 'Content-Type: text/plain;charset=UTF-8' -d '{"name":"闯入者","count":"1"}')"
ck "读名单不带口令 -> 401"  '口令不正确' "$(plain /api/list)"
ck "health 不带口令 -> 401" '口令不正确' "$(plain /health)"
ck "口令错 -> 401"          '口令不正确' "$(list 'wrong-token')"
ck "闯入者没被写进名单"      "false"     "$(printf '%s' "$(list $TOK)" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(str(any(x["name"]=="闯入者" for x in d["records"])).lower())')"

echo "== 写入与修改 =="
ck "新建"            '"mode":"created"' "$(post '{"name":"张三","count":"2"}')"
ck "同名再写 = 修改"  '"mode":"updated"' "$(post '{"name":"张三","count":"3"}')"
ck "中英文混合姓名"   '"ok":true'        "$(post '{"name":"李四 Lisa","count":"1"}')"
ck "姓名含 emoji"     '"ok":true'        "$(post '{"name":"小明 🎉","count":"2"}')"

echo "== 校验 =="
ck "空姓名被拒"     '请填写姓名'   "$(post '{"name":"   ","count":"2"}')"
ck "缺 name 被拒"   '请填写姓名'   "$(post '{"count":"2"}')"
ck "坏 JSON 被拒"   '请求格式错误' "$(post 'not json')"
ck "数组 body 被拒" '请填写姓名'   "$(post '[1,2,3]')"

echo "== 人数收进 1-5 =="
post '{"name":"超上限","count":"99"}' >/dev/null
post '{"name":"负数","count":"-3"}'   >/dev/null
post '{"name":"非法","count":"abc"}'  >/dev/null
J=$(list $TOK)
ck "99 → 5"  '"name":"超上限","count":5' "$J"
ck "-3 → 1"  '"name":"负数","count":1'   "$J"
ck "abc → 1" '"name":"非法","count":1'   "$J"

echo "== created_at 不被覆盖、不产生重复 =="
C1=$(printf '%s' "$(list $TOK)" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([x for x in d["records"] if x["name"]=="张三"][0]["createdAt"])')
sleep 1; post '{"name":"张三","count":"4"}' >/dev/null
J=$(list $TOK)
ck "张三只有一条"     "1"   "$(printf '%s' "$J" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len([x for x in d["records"] if x["name"]=="张三"]))')"
ck "首次登记时间保留" "$C1" "$(printf '%s' "$J" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([x for x in d["records"] if x["name"]=="张三"][0]["createdAt"])')"
U2=$(printf '%s' "$J" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([x for x in d["records"] if x["name"]=="张三"][0]["updatedAt"])')
ck "最后修改时间刷新" "true" "$([[ "$U2" > "$C1" ]] && echo true || echo false)"

echo "== 批量补录：不再有限流挡路 =="
for i in $(seq 1 80); do post "{\"name\":\"补录$i\",\"count\":\"2\"}" >/dev/null; done
ck "连写 80 条全部进名单" "true" "$(printf '%s' "$(list $TOK)" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(str(sum(1 for x in d["records"] if x["name"].startswith("补录"))==80).lower())')"

echo "== /health =="
H=$(curl -s -m 10 "$B/health" -H "x-admin-token: $TOK")
ck "health 返回 ok"        '"ok":true'        "$H"
ck "health 带条数"         'entries'          "$H"
ck "health 带最近写入时间" 'lastSubmissionAt' "$H"

echo "== 汇总数字自洽 =="
ck "attendingPeople = 各条人数之和" "true" "$(printf '%s' "$(list $TOK)" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(str(d["summary"]["attendingPeople"]==sum(x["count"] for x in d["records"])).lower())')"
ck "entries = 记录条数"             "true" "$(printf '%s' "$(list $TOK)" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(str(d["summary"]["entries"]==len(d["records"])).lower())')"

echo "== CORS =="
ck "白名单第一个来源被回显" "Access-Control-Allow-Origin: $ORG" \
   "$(curl -s -m 10 -i "$B/api/list" -H "x-admin-token: $TOK" -H "Origin: $ORG" | tr -d '\r')"
ck "白名单第二个来源被回显" "Access-Control-Allow-Origin: $ORG2" \
   "$(curl -s -m 10 -i "$B/api/list" -H "x-admin-token: $TOK" -H "Origin: $ORG2" | tr -d '\r')"
ck "陌生来源不被回显"       "Access-Control-Allow-Origin: $ORG" \
   "$(curl -s -m 10 -i "$B/api/list" -H "x-admin-token: $TOK" -H 'Origin: https://evil.example' | tr -d '\r')"
ck "401 也带 CORS 头"       'Access-Control-Allow-Origin' \
   "$(curl -s -m 10 -i "$B/api/list" -H "Origin: $ORG" | tr -d '\r')"
ck "OPTIONS 预检 -> 204"    '204' \
   "$(curl -s -m 10 -i -X OPTIONS "$B/api/rsvp" -H "Origin: $ORG" | tr -d '\r')"

echo "== 404 =="
ck "未知路径（带口令）" '接口不存在' "$(curl -s -m 10 "$B/api/nope" -H "x-admin-token: $TOK")"

echo
echo "通过 $pass 项，失败 $fail 项"
[[ $fail -eq 0 ]]
