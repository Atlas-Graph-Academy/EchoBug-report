#!/bin/bash

# 迁移脚本：帮助将仓库迁移到组织账户
# 使用方法: ./migrate.sh [组织名] [新仓库名（可选，默认使用当前名称）]

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查参数
if [ -z "$1" ]; then
    echo -e "${RED}错误: 请提供组织名称${NC}"
    echo "使用方法: ./migrate.sh [组织名] [新仓库名（可选）]"
    exit 1
fi

ORG_NAME=$1
REPO_NAME=${2:-"EchoBug-report"}

echo -e "${GREEN}开始迁移到组织: $ORG_NAME${NC}"
echo -e "${YELLOW}新仓库名称: $REPO_NAME${NC}"
echo ""

# 检查当前 Git 状态
echo -e "${YELLOW}检查 Git 状态...${NC}"
if ! git status &> /dev/null; then
    echo -e "${RED}错误: 当前目录不是 Git 仓库${NC}"
    exit 1
fi

# 检查是否有未提交的更改
if ! git diff-index --quiet HEAD --; then
    echo -e "${YELLOW}警告: 检测到未提交的更改${NC}"
    read -p "是否继续？(y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# 显示当前远程地址
echo -e "${YELLOW}当前远程地址:${NC}"
git remote -v
echo ""

# 确认
read -p "确认要更新远程地址到 git@github.com:$ORG_NAME/$REPO_NAME.git? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 0
fi

# 更新远程地址
echo -e "${YELLOW}更新远程地址...${NC}"
git remote set-url origin "git@github.com:$ORG_NAME/$REPO_NAME.git"

# 验证更新
echo -e "${GREEN}新的远程地址:${NC}"
git remote -v
echo ""

# 检查是否可以连接到新仓库
echo -e "${YELLOW}测试连接到新仓库...${NC}"
if git ls-remote --exit-code origin &> /dev/null; then
    echo -e "${GREEN}✓ 成功连接到新仓库${NC}"
else
    echo -e "${RED}✗ 无法连接到新仓库${NC}"
    echo -e "${YELLOW}请确保:${NC}"
    echo "  1. 新仓库已在 GitHub 上创建"
    echo "  2. 你有访问权限"
    echo "  3. SSH 密钥已配置"
    exit 1
fi

# 询问是否推送
read -p "是否现在推送代码到新仓库? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}推送代码...${NC}"
    git push -u origin main
    
    # 推送所有分支
    if [ $(git branch -r | wc -l) -gt 1 ]; then
        echo -e "${YELLOW}推送所有分支...${NC}"
        git push origin --all
    fi
    
    # 推送标签
    if [ $(git tag | wc -l) -gt 0 ]; then
        echo -e "${YELLOW}推送标签...${NC}"
        git push origin --tags
    fi
    
    echo -e "${GREEN}✓ 代码已成功推送到新仓库${NC}"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}迁移步骤 1-3 完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}接下来的步骤:${NC}"
echo "1. 在组织的 Vercel Pro 账户中创建新项目"
echo "2. 导入新仓库: $ORG_NAME/$REPO_NAME"
echo "3. 配置环境变量"
echo "4. 配置域名（如果有）"
echo ""
echo -e "${YELLOW}详细说明请查看 MIGRATION_GUIDE.md${NC}"
