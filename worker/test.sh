#!/usr/bin/env bash
# 对着本地 dev worker 跑一遍登记接口。用法：bash worker/test.sh [端口]
B="http://127.0.0.1:${1:-8813}"
TOK=test-token-1234567890
ORG='https://www.taolinwei.com'
ORG2='https://linwei94.github.io'
pass=0; fail=0
ck(){ if [[ "$3" == *"$2"* ]]; then echo "  PASS  $1"; pass=$((pass+1));
      else echo "  FAIL  $1"; echo "        期望包含: $2"; echo "        实际: $3"; fail=$((fail+1)); fi; }

post(){ curl -s -m 10 -X POST "$B/api/rsvp" -H 'Content-Type: text/plain;charset=UTF-8' -H "Origin: $ORG" -d "$1"; }
list(){ curl -s -m 10 "$B/api/list" -H "x-admin-token: $1" -H "Origin: $ORG"; }

echo "== 提交与修改 =="
ck "新建"                '"mode":"created"' "$(post '{"name":"张三","count":"2"}')"
ck "同名再交 = 修改"      '"mode":"updated"' "$(post '{"name":"张三","count":"3"}')"
ck "中英文混合姓名"      '"ok":true'        "$(post '{"name":"李四 Lisa","count":"1"}')"

echo "== 校验 =="
ck "空姓名被拒"          '请填写姓名'   "$(post '{"name":"   ","count":"2"}')"
ck "缺 name 被拒"        '请填写姓名'   "$(post '{"count":"2"}')"
ck "坏 JSON 被拒"        '请求格式错误' "$(post 'not json')"
ck "数组 body 被拒"      '请填写姓名'   "$(post '[1,2,3]')"

echo "== 后台读取 =="
ck "没口令 401"          '口令不正确' "$(list '')"
ck "错口令 401"          '口令不正确' "$(list 'wrong')"
ck "对口令拿到名单"      '"ok":true'  "$(list $TOK)"

echo "== 人数收进 1-5 =="
post '{"name":"超上限","count":"99"}' >/dev/null
post '{"name":"负数","count":"-3"}'   >/dev/null
post '{"name":"非法","count":"abc"}'  >/dev/null
J=$(list $TOK)
ck "99 → 5"  '"name":"超上限","count":5' "$J"
ck "-3 → 1"  '"name":"负数","count":1'   "$J"
ck "abc → 1" '"name":"非法","count":1'   "$J"

echo "== created_at 不被覆盖 =="
C1=$(printf '%s' "$(list $TOK)" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([x for x in d["records"] if x["name"]=="张三"][0]["createdAt"])')
sleep 1; post '{"name":"张三","count":"4"}' >/dev/null
J=$(list $TOK)
DUP=$(printf '%s' "$J" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len([x for x in d["records"] if x["name"]=="张三"]))')
C2=$(printf '%s' "$J" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([x for x in d["records"] if x["name"]=="张三"][0]["createdAt"])')
U2=$(printf '%s' "$J" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([x for x in d["records"] if x["name"]=="张三"][0]["updatedAt"])')
ck "张三只有一条"      "1"    "$DUP"
ck "首次登记时间保留"  "$C1"  "$C2"
ck "最后修改时间刷新"  "true" "$([[ "$U2" > "$C1" ]] && echo true || echo false)"

echo "== 蜜罐 =="
ck "填了蜜罐也返回成功（不给脚本反馈）" '"ok":true' "$(post '{"name":"机器人","count":"1","website_url":"http://spam"}')"
ck "但不写进名单" "false" "$(printf '%s' "$(list $TOK)" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(str(any(x["name"]=="机器人" for x in d["records"])).lower())')"

echo "== /health =="
H=$(curl -s -m 10 "$B/health")
ck "health 返回 ok"       '"ok":true'          "$H"
ck "health 带条数"        'entries'            "$H"
ck "health 带最近提交时间" 'lastSubmissionAt'  "$H"

echo "== CORS =="
ck "写入接口对任意来源放开" 'Access-Control-Allow-Origin: *' \
   "$(curl -s -m 10 -i -X POST "$B/api/rsvp" -H 'Content-Type: text/plain;charset=UTF-8' -H 'Origin: https://somewhere.example' -d '{"name":"跨域测试","count":"1"}' | tr -d '\r')"
ck "读取接口只认自己的页面" "Access-Control-Allow-Origin: $ORG" \
   "$(curl -s -m 10 -i "$B/api/list" -H "x-admin-token: $TOK" -H "Origin: $ORG" | tr -d '\r')"
ck "名单里第二个来源也放行" "Access-Control-Allow-Origin: $ORG2" \
   "$(curl -s -m 10 -i "$B/api/list" -H "x-admin-token: $TOK" -H "Origin: $ORG2" | tr -d '\r')"
ck "读取接口不回显陌生来源" "Access-Control-Allow-Origin: $ORG" \
   "$(curl -s -m 10 -i "$B/api/list" -H "x-admin-token: $TOK" -H 'Origin: https://evil.example' | tr -d '\r')"
ck "出错也带 CORS 头" 'Access-Control-Allow-Origin' \
   "$(curl -s -m 10 -i "$B/api/list" -H 'Origin: '"$ORG" | tr -d '\r')"

echo "== 404 =="
ck "未知路径" '接口不存在' "$(curl -s -m 10 "$B/api/nope")"

echo
echo "通过 $pass 项，失败 $fail 项"
[[ $fail -eq 0 ]]
