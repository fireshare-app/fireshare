"""add custom games

Revision ID: t5o6p7q8r9s0
Revises: s4n5o6p7q8r9
Create Date: 2026-10-09 10:00:00.000000

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


def upgrade():
    # A custom game is one a curator added by hand with their own artwork,
    # rather than one fetched from SteamGridDB. It still gets a steamgriddb_id
    # (allocated above CUSTOM_GAME_ID_BASE, see models.py) so every route and
    # asset path keyed on that column keeps working; this flag is what tells the
    # two apart, so the asset fallback never asks SteamGridDB for it.
    if not column_exists('game_metadata', 'is_custom'):
        with op.batch_alter_table('game_metadata', schema=None) as batch_op:
            batch_op.add_column(
                sa.Column('is_custom', sa.Boolean(), nullable=False, server_default='0')
            )


def downgrade():
    if column_exists('game_metadata', 'is_custom'):
        with op.batch_alter_table('game_metadata', schema=None) as batch_op:
            batch_op.drop_column('is_custom')
