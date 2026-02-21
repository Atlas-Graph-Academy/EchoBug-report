'use client';

import React, { useEffect, useState } from 'react';
import { Button, Input, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  ReloadOutlined,
  SendOutlined,
} from '@ant-design/icons';

interface Signup {
  id: string;
  name: string;
  email: string;
  status: 'pending' | 'approved' | 'rejected' | 'invited';
  created_at: string;
  how_did_you_hear: string;
  message: string;
  invitation_code?: string;
  invitation_sent_at?: string;
}

const { Option } = Select;
const { Search } = Input;

export default function WaitlistDashboard() {
  const [data, setData] = useState<Signup[]>([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [filters, setFilters] = useState({ status: 'all', search: '' });
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  const fetchData = async (page = 1, pageSize = 20) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
        status: filters.status,
        search: filters.search,
      });
      const res = await fetch(`/api/waitlist/list?${params.toString()}`);
      const json = await res.json();

      if (json.success) {
        setData(json.users);
        setPagination({
          current: json.page,
          pageSize: json.pageSize,
          total: json.total,
        });
      } else {
        message.error(json.error || 'Failed to fetch waitlist');
      }
    } catch (err) {
      console.error(err);
      message.error('Error fetching waitlist');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(pagination.current, pagination.pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const handleStatusChange = async (ids: string[], newStatus: string) => {
    try {
      const res = await fetch('/api/waitlist/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, status: newStatus }),
      });
      const json = await res.json();

      if (json.success) {
        message.success(`Updated ${ids.length} users to ${newStatus}`);
        fetchData(pagination.current, pagination.pageSize);
        setSelectedRowKeys([]);
      } else {
        message.error(json.error || 'Failed updates');
      }
    } catch (err) {
      console.error(err);
      message.error('Error updating status');
    }
  };

  const handleInvite = async (ids: string[]) => {
    try {
      const res = await fetch('/api/waitlist/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const json = await res.json();

      if (json.success) {
        message.success(`Invited ${json.invited} users`);
        fetchData(pagination.current, pagination.pageSize);
        setSelectedRowKeys([]);
      } else {
        message.error(json.error || 'Failed invites');
      }
    } catch (err) {
      console.error(err);
      message.error('Error inviting users');
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (text: string) => <b>{text}</b>,
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        let color = 'default';
        if (status === 'approved') color = 'green';
        if (status === 'rejected') color = 'red';
        if (status === 'invited') color = 'blue';
        if (status === 'pending') color = 'orange';
        return <Tag color={color}>{status.toUpperCase()}</Tag>;
      },
    },
    {
      title: 'Source',
      dataIndex: 'how_did_you_hear',
      key: 'source',
      ellipsis: true,
    },
    {
      title: 'Message',
      dataIndex: 'message',
      key: 'message',
      ellipsis: true,
      render: (text: string) => (
        <Tooltip title={text}>
          <span>{text && text.length > 20 ? `${text.substring(0, 20)}...` : text}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Invitation',
      key: 'invitation',
      render: (_: unknown, record: Signup) => (
        <Space direction="vertical" size="small">
          {record.invitation_code && <Tag color="purple">{record.invitation_code}</Tag>}
          {record.invitation_sent_at && (
            <span style={{ fontSize: 10, color: '#888' }}>
              {new Date(record.invitation_sent_at).toLocaleDateString()}
            </span>
          )}
        </Space>
      ),
    },
    {
      title: 'Date',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
    {
      title: 'Action',
      key: 'action',
      render: (_: unknown, record: Signup) => (
        <Space size="middle">
          {record.status !== 'invited' && (
            <Button
              size="small"
              type="primary"
              ghost
              icon={<SendOutlined />}
              onClick={() => handleInvite([record.id])}
            >
              Invite
            </Button>
          )}
          {record.status === 'pending' && (
            <>
              <Button
                size="small"
                type="text"
                icon={<CheckOutlined style={{ color: 'green' }} />}
                onClick={() => handleStatusChange([record.id], 'approved')}
              />
              <Button
                size="small"
                type="text"
                icon={<CloseOutlined style={{ color: 'red' }} />}
                onClick={() => handleStatusChange([record.id], 'rejected')}
              />
            </>
          )}
        </Space>
      ),
    },
  ];

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: React.Key[]) => setSelectedRowKeys(keys),
  };

  return (
    <div style={{ padding: 24, background: '#f0f2f5', minHeight: '100vh' }}>
      <div style={{ background: '#fff', padding: 24, borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2>Waitlist Dashboard</h2>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => fetchData(pagination.current, pagination.pageSize)}
            >
              Refresh
            </Button>
          </Space>
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
          <Search
            placeholder="Search name or email"
            onSearch={(val) => setFilters({ ...filters, search: val })}
            style={{ width: 200 }}
            allowClear
          />
          <Select
            defaultValue="all"
            style={{ width: 120 }}
            onChange={(val) => setFilters({ ...filters, status: val })}
          >
            <Option value="all">All Status</Option>
            <Option value="pending">Pending</Option>
            <Option value="approved">Approved</Option>
            <Option value="rejected">Rejected</Option>
            <Option value="invited">Invited</Option>
          </Select>

          {selectedRowKeys.length > 0 && (
            <Space>
              <Button type="primary" onClick={() => handleInvite(selectedRowKeys as string[])}>
                Invite Selected ({selectedRowKeys.length})
              </Button>
              <Button onClick={() => handleStatusChange(selectedRowKeys as string[], 'approved')}>
                Approve Selected
              </Button>
              <Button danger onClick={() => handleStatusChange(selectedRowKeys as string[], 'rejected')}>
                Reject Selected
              </Button>
            </Space>
          )}
        </div>

        <Table
          columns={columns}
          dataSource={data}
          loading={loading}
          rowKey="id"
          rowSelection={rowSelection}
          pagination={{
            ...pagination,
            onChange: (page, pageSize) => fetchData(page, pageSize || 20),
          }}
          scroll={{ x: 1000 }}
        />
      </div>
    </div>
  );
}
