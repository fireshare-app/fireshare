"""add hdr tone map columns to video_info

Revision ID: t5o6p7q8r9s0
Revises: s4n5o6p7q8r9
Create Date: 2026-10-10 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 't5o6p7q8r9s0'
down_revision = 's4n5o6p7q8r9'
branch_labels = None
depends_on = None


def column_exists(table_name, column_name):
    """Check if a column exists in a table."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [col['name'] for col in inspector.get_columns(table_name)]
    return column_name in columns


COLUMNS = (
    # NULL until the scan has looked at the stored stream tags (detect-hdr).
    sa.Column('is_hdr', sa.Boolean(), nullable=True),
    # The operator the SDR copy is made with; NULL when none is wanted.
    sa.Column('tonemap', sa.String(16), nullable=True),
    sa.Column('has_sdr', sa.Boolean(), nullable=True, server_default=sa.false()),
    sa.Column('sdr_error', sa.String(512), nullable=True),
)


def upgrade():
    with op.batch_alter_table('video_info', schema=None) as batch_op:
        for column in COLUMNS:
            if not column_exists('video_info', column.name):
                batch_op.add_column(column)


def downgrade():
    with op.batch_alter_table('video_info', schema=None) as batch_op:
        for column in COLUMNS:
            if column_exists('video_info', column.name):
                batch_op.drop_column(column.name)
