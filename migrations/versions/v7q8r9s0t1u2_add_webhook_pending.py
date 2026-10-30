"""add webhook_pending to video_info

Revision ID: v7q8r9s0t1u2
Revises: u6p7q8r9s0t1
Create Date: 2026-10-30 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'v7q8r9s0t1u2'
down_revision = 'u6p7q8r9s0t1'
branch_labels = None
depends_on = None


def column_exists(table_name, column_name):
    """Check if a column exists in a table."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [col['name'] for col in inspector.get_columns(table_name)]
    return column_name in columns


def upgrade():
    if not column_exists('video_info', 'webhook_pending'):
        with op.batch_alter_table('video_info', schema=None) as batch_op:
            batch_op.add_column(sa.Column('webhook_pending', sa.Boolean(), nullable=True, server_default=sa.false()))


def downgrade():
    if column_exists('video_info', 'webhook_pending'):
        with op.batch_alter_table('video_info', schema=None) as batch_op:
            batch_op.drop_column('webhook_pending')
