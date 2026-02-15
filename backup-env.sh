#!/bin/bash

# Vercel 环境变量备份脚本
# 使用方法: ./backup-env.sh

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

BACKUP_DIR="./vercel-env-backup"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo -e "${GREEN}Vercel 环境变量备份工具${NC}"
echo ""

# 检查 Vercel CLI 是否安装
if ! command -v vercel &> /dev/null; then
    echo -e "${RED}错误: Vercel CLI 未安装${NC}"
    echo "安装方法: npm i -g vercel"
    exit 1
fi

# 检查是否已登录
if ! vercel whoami &> /dev/null; then
    echo -e "${YELLOW}需要登录 Vercel...${NC}"
    vercel login
fi

# 创建备份目录
mkdir -p "$BACKUP_DIR"

echo -e "${YELLOW}备份环境变量...${NC}"

# 备份不同环境的环境变量
for env in production preview development; do
    echo -e "${YELLOW}备份 $env 环境...${NC}"
    vercel env pull ".env.$env" --environment=$env --yes 2>/dev/null || {
        echo -e "${YELLOW}  $env 环境没有环境变量或无法访问${NC}"
        continue
    }
    
    if [ -f ".env.$env" ]; then
        mv ".env.$env" "$BACKUP_DIR/.env.$env"
        echo -e "${GREEN}  ✓ $env 环境变量已备份${NC}"
    fi
done

# 创建汇总文件
SUMMARY_FILE="$BACKUP_DIR/ENV_SUMMARY_$TIMESTAMP.txt"
echo "环境变量备份汇总 - $TIMESTAMP" > "$SUMMARY_FILE"
echo "================================" >> "$SUMMARY_FILE"
echo "" >> "$SUMMARY_FILE"

for env_file in "$BACKUP_DIR"/.env.*; do
    if [ -f "$env_file" ]; then
        env_name=$(basename "$env_file" | sed 's/\.env\.//')
        echo "环境: $env_name" >> "$SUMMARY_FILE"
        echo "变量数量: $(grep -v '^#' "$env_file" | grep -v '^$' | wc -l | tr -d ' ')" >> "$SUMMARY_FILE"
        echo "" >> "$SUMMARY_FILE"
    fi
done

echo ""
echo -e "${GREEN}✓ 备份完成！${NC}"
echo -e "${GREEN}备份位置: $BACKUP_DIR${NC}"
echo -e "${GREEN}汇总文件: $SUMMARY_FILE${NC}"
echo ""
echo -e "${YELLOW}重要提示:${NC}"
echo "1. 这些文件包含敏感信息，请妥善保管"
echo "2. 不要将备份文件提交到 Git"
echo "3. 迁移完成后，在新 Vercel 项目中手动添加这些环境变量"
echo ""
echo -e "${YELLOW}查看备份内容:${NC}"
echo "  ls -la $BACKUP_DIR"
echo "  cat $SUMMARY_FILE"
