"""repair game_metadata.is_custom after the fork's revision id collision

Revision ID: w8r9s0t1u2v3
Revises: v7q8r9s0t1u2
Create Date: 2026-10-14 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'w8r9s0t1u2v3'
down_revision = 'v7q8r9s0t1u2'
branch_labels = None
depends_on = None


def column_exists(table_name, column_name):
    bind = op.get_bind()
    return column_name in {c['name'] for c in sa.inspect(bind).get_columns(table_name)}


def upgrade():
    # Fork releases 1.9.0/1.9.1 shipped the Discord migration as t5o6p7q8r9s0, the
    # same id upstream later gave add_custom_games. Databases stamped by those
    # releases therefore skip upstream's is_custom column; add it here if missing.
    if not column_exists('game_metadata', 'is_custom'):
        with op.batch_alter_table('game_metadata', schema=None) as batch_op:
            batch_op.add_column(
                sa.Column('is_custom', sa.Boolean(), nullable=False, server_default='0')
            )


def downgrade():
    # Nothing to undo: on a clean history the column belongs to t5o6p7q8r9s0.
    pass
