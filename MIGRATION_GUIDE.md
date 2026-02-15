# 迁移指南：从个人账户迁移到组织账户

本指南将帮助你平滑地将代码库和 Vercel 部署从个人账户迁移到组织账户。

## 📋 迁移前准备清单

- [ ] 确认目标组织账户名称
- [ ] 确认目标组织有 Vercel Pro 账户
- [ ] 备份所有环境变量
- [ ] 记录当前域名配置（如果有）
- [ ] 确认团队成员访问权限

## 🔄 迁移步骤

### 第一步：备份当前配置

#### 1.1 导出 Vercel 环境变量
在 Vercel Dashboard 中：
1. 进入项目设置 → Environment Variables
2. 手动记录所有环境变量，或使用 Vercel CLI 导出：
```bash
vercel env pull .env.local
```

#### 1.2 记录 Vercel 项目配置
- 项目名称
- 框架预设（Next.js）
- 构建命令和输出目录
- 域名配置
- 环境变量（开发、预览、生产）

### 第二步：在组织账户下创建新的 GitHub 仓库

#### 2.1 在 GitHub 上创建新仓库
1. 登录到目标组织账户
2. 创建新仓库（建议使用相同名称：`EchoBug-report`）
3. **不要**初始化 README、.gitignore 或 license（因为已有代码）

#### 2.2 更新本地 Git 远程地址
```bash
# 查看当前远程地址
git remote -v

# 更新为新的组织仓库地址
git remote set-url origin git@github.com:[组织名]/EchoBug-report.git

# 验证更新
git remote -v
```

### 第三步：推送代码到新仓库

```bash
# 确保所有更改已提交
git status

# 推送所有分支和标签到新仓库
git push -u origin main

# 如果有其他分支
git push origin --all
git push origin --tags
```

### 第四步：迁移 Vercel 部署

#### 4.1 在组织账户下创建新项目

**选项 A：通过 Vercel Dashboard（推荐）**
1. 登录到组织的 Vercel Pro 账户
2. 点击 "Add New..." → "Project"
3. 导入新创建的 GitHub 仓库
4. 配置项目设置：
   - Framework Preset: Next.js
   - Root Directory: `./`（如果项目在根目录）
   - Build Command: `npm run build`（或 `next build`）
   - Output Directory: `.next`
   - Install Command: `npm install`

**选项 B：通过 Vercel CLI**
```bash
# 登录到组织账户
vercel login

# 切换到组织
vercel teams switch [组织名]

# 在项目目录中初始化
cd "/Users/kobe/EchoBug report"
vercel --yes

# 链接到新仓库
vercel link
```

#### 4.2 迁移环境变量
1. 在 Vercel Dashboard 中进入新项目
2. 进入 Settings → Environment Variables
3. 添加所有之前记录的环境变量
4. 确保为每个环境（Development, Preview, Production）正确设置

#### 4.3 配置域名（如果有自定义域名）
1. 在 Vercel Dashboard → Settings → Domains
2. 添加之前使用的域名
3. 更新 DNS 记录（如果需要）

### 第五步：测试新部署

1. 触发一次新的部署：
   ```bash
   git commit --allow-empty -m "Trigger deployment after migration"
   git push
   ```

2. 验证部署：
   - 检查构建日志
   - 测试生产环境功能
   - 验证环境变量是否正确加载
   - 测试 API 路由

### 第六步：更新相关配置（如果需要）

#### 6.1 更新 CI/CD 配置
如果有 GitHub Actions 或其他 CI/CD，更新仓库地址。

#### 6.2 更新文档和链接
更新 README、文档中的仓库链接。

### 第七步：清理旧资源（可选）

**⚠️ 重要：只有在确认新部署完全正常后才执行此步骤**

#### 7.1 删除个人账户下的 Vercel 项目
1. 在个人账户的 Vercel Dashboard 中
2. 进入项目设置 → General
3. 滚动到底部，点击 "Delete Project"

#### 7.2 删除个人账户下的 GitHub 仓库（如果需要）
1. 在 GitHub 仓库设置中
2. 进入 Danger Zone
3. 删除仓库

## 🚨 零停机时间迁移策略

为了确保服务不中断，建议按以下顺序操作：

1. **先迁移代码库**（步骤 2-3）
2. **在新组织下创建 Vercel 项目**（步骤 4.1）
3. **配置环境变量和域名**（步骤 4.2-4.3）
4. **测试新部署**（步骤 5）
5. **切换 DNS/域名指向新部署**（如果有自定义域名）
6. **等待 DNS 传播完成**（通常 5-30 分钟）
7. **确认新部署正常后，再删除旧资源**（步骤 7）

## 📝 迁移后检查清单

- [ ] 新仓库代码完整
- [ ] Vercel 部署成功
- [ ] 所有环境变量已迁移
- [ ] 生产环境功能正常
- [ ] API 路由正常工作
- [ ] 域名配置正确（如果有）
- [ ] 团队成员可以访问新仓库和 Vercel 项目
- [ ] 自动部署正常工作（push 到 main 分支触发部署）

## 🔧 常见问题

### Q: 如果迁移过程中出现问题怎么办？
A: 旧部署仍然运行，可以回滚。确保在删除旧资源前充分测试新部署。

### Q: 环境变量很多，有没有批量导入的方法？
A: 可以使用 Vercel CLI：
```bash
# 从旧项目导出
vercel env pull .env.local --environment=production

# 在新项目中导入（需要手动添加到 Vercel Dashboard，或使用 API）
```

### Q: 如何确保团队成员有访问权限？
A: 
- GitHub: 在组织设置中添加团队成员
- Vercel: 在项目设置 → Team 中添加成员

## 📞 需要帮助？

如果在迁移过程中遇到问题：
1. 检查 Vercel 构建日志
2. 验证环境变量是否正确
3. 确认 Git 远程地址已更新
4. 检查组织账户权限设置
